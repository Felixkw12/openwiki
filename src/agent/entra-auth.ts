/**
 * Build an OpenAI SDK credential callback. Azure Identity caches tokens and
 * refreshes them before expiry; the SDK invokes this callback for each request,
 * including requests from an already-constructed model during a long run.
 * Load Azure Identity lazily so other providers do not initialize its chain.
 */
export function createEntraTokenProvider(
  baseURL: string | undefined,
  scope: string,
): () => Promise<string> {
  let endpoint: URL;
  try {
    endpoint = new URL(baseURL ?? "");
  } catch {
    throw new Error(
      "Entra ID authentication requires an HTTPS OPENAI_COMPATIBLE_BASE_URL.",
    );
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error(
      "Entra ID authentication requires an HTTPS OPENAI_COMPATIBLE_BASE_URL without embedded credentials.",
    );
  }

  let tokenProvider: Promise<() => Promise<string>> | undefined;
  return async () => {
    try {
      tokenProvider ??= import("@azure/identity").then(
        ({ DefaultAzureCredential, getBearerTokenProvider }) =>
          getBearerTokenProvider(new DefaultAzureCredential(), scope),
      );
      return await (
        await tokenProvider
      )();
    } catch {
      // SDK errors can include identity-service responses or credential values.
      // Never attach the original error or return it through model diagnostics.
      throw new Error(
        "Unable to obtain a Microsoft Entra ID access token. Configure Azure Identity (az login, managed/workload identity, or environment credentials) and check OPENAI_COMPATIBLE_ENTRA_SCOPE and gateway access permissions.",
      );
    }
  };
}
