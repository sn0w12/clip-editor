import { queryOptions } from "@tanstack/react-query";

import type { EchoResult } from "../protocol";
import type { BackendClient } from "../transport/client";
import { expectOk } from "../transport/result";
import { appKeys } from "./query-keys";

export interface AppQueryDeps {
    backend: BackendClient;
}

/**
 * Every queryFn unwraps the client Result via `expectOk`: react-query
 * models failure through rejection, so an Err surfaces as `query.error`
 * with the full BackendError. That is the only place a Result is allowed
 * to be unwrapped blindly.
 */
export function appInfoQuery(deps: AppQueryDeps) {
    return queryOptions({
        queryKey: appKeys.info(),
        queryFn: async () => expectOk(await deps.backend.app.info()),
        staleTime: Infinity,
    });
}

export function pingQuery(deps: AppQueryDeps) {
    return queryOptions({
        queryKey: appKeys.ping(),
        queryFn: async () => expectOk(await deps.backend.app.ping()),
        staleTime: 10_000,
    });
}

export function echoMutation(deps: AppQueryDeps) {
    return {
        mutationFn: async (message: string): Promise<EchoResult> =>
            expectOk(await deps.backend.app.echo({ message })),
    };
}
