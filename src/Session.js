import Transaction from './Transaction';
import { ops } from './utils';

/**
 * Session handles a single
 * action dispatch.
 */
const Session = class Session {
    /**
     * Creates a new Session.
     *
     * @param  {Schema} schema - a {@link Schema} instance
     * @param  {Object} state - the database state
     * @param  {Object} [action] - the current action in the dispatch cycle.
     *                             Will be passed to the user defined reducers.
     * @param  {Boolean} withMutations - whether the session should mutate data
     */
    constructor(schema, state, action, withMutations) {
        this.schema = schema;
        this.state = state || schema.getDefaultState();
        this.action = action;
        this.withMutations = !!withMutations;

        this.currentTx = new Transaction();

        this._accessedModels = {};
        this.modelData = {};

        this.models = schema.getModelClasses();

        this.sessionBoundModels = this.models.map(modelClass => {
            const sessionBoundModel = class SessionBoundModel extends modelClass {};
            Object.defineProperty(this, modelClass.modelName, {
                get: () => sessionBoundModel,
            });

            sessionBoundModel.connect(this);
            return sessionBoundModel;
        });
    }

    markAccessed(model) {
        this.getDataForModel(model.modelName).accessed = true;
    }

    get accessedModels() {
        return this.sessionBoundModels
            .filter(model => !!this.getDataForModel(model.modelName).accessed)
            .map(model => model.modelName);
    }

    getDataForModel(modelName) {
        if (!this.modelData[modelName]) {
            this.modelData[modelName] = {};
        }

        return this.modelData[modelName];
    }

    /**
     * Records an update to the session.
     *
     * @private
     * @param {Object} update - the update object. Must have keys
     *                          `type`, `payload` and `meta`. `meta`
     *                          must also include a `name` attribute
     *                          that contains the model name.
     */
    addUpdate(update) {
        if (this.withMutations) {
            const modelName = update.meta.name;
            const modelState = this.getState(modelName);

            // The backend used in the updateReducer
            // will mutate the model state.
            this[modelName].updateReducer(null, modelState, update);
        } else {
            this.currentTx.addUpdate(update);
        }
    }

    getUpdatesFor(modelName) {
        return this.currentTx.getUpdatesFor(modelName);
    }

    get updates() {
        return this.currentTx.updates.map(update => update.update);
    }

    /**
     * Returns the current state for a model with name `modelName`.
     *
     * @private
     * @param  {string} modelName - the name of the model to get state for.
     * @return {*} The state for model with name `modelName`.
     */
    getState(modelName) {
        return this.state[modelName];
    }

    /**
     * Applies recorded updates and returns the next state.
     * @param  {Object} [opts] - Options object
     * @param  {Boolean} [opts.runReducers] - A boolean indicating if the user-defined
     *                                        model reducers should be run. If not specified,
     *                                        is set to `true` if an action object was specified
     *                                        on session instantiation, otherwise `false`.
     * @return {Object} The next state
     */
    getNextState(userOpts) {
        if (this.withMutations) return this.state;

        const prevState = this.state;
        const action = this.action;
        const opts = userOpts || {};

        // If the session does not have a specified action object,
        // don't run the user-defined model reducers unless
        // explicitly specified.
        const runReducers = opts.hasOwnProperty('runReducers')
            ? opts.runReducers
            : !!action;

        const tx = this.currentTx;
        ops.open();

        let nextState = prevState;
        if (runReducers) {
            nextState = this.sessionBoundModels.reduce((_nextState, modelClass) => {
                const modelState = this.getState(modelClass.modelName);

                let returnValue = modelClass.reducer(modelState, action, modelClass, this);
                if (typeof returnValue === 'undefined') {
                    returnValue = modelClass.getNextState(tx);
                }
                return ops.set(modelClass.modelName, returnValue, _nextState);
            }, nextState);
        }

        // There might be some m2m updates left.
        const unappliedUpdates = this.currentTx.getUnappliedUpdatesByModel();
        if (unappliedUpdates) {
            nextState = this.sessionBoundModels.reduce((_nextState, modelClass) => {
                const modelName = modelClass.modelName;
                if (!unappliedUpdates.hasOwnProperty(modelName)) {
                    return _nextState;
                }

                return ops.set(modelName, modelClass.getNextState(tx), _nextState);
            }, nextState);
        }

        ops.close();
        tx.close();
        this.currentTx = new Transaction();

        return nextState;
    }

    /**
     * Calls the user-defined reducers and returns the next state.
     * If the session uses mutations, just returns the state.
     * Delegates to {@link Session#getNextState}
     *
     * @return {Object} the next state
     */
    reduce() {
        return this.getNextState({ runReducers: true });
    }
};

export default Session;
