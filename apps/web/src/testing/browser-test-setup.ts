// Every browser test renders with `act`, so React must expect it.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
