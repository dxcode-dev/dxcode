import type { Endpoint } from "./http/endpoint.js";

// A deployment lists its own endpoints here, apart from the app's
// (`dxEndpoints`). Public dx lists none.
export const deploymentEndpoints: ReadonlyArray<Endpoint> = [];
