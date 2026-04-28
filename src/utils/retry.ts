/**
 * Generic retry utility for wrapping async operations.
 * Retries the given function up to `retries` times with exponential backoff.
 * Each retry waits (attempt + 1) * delay ms, so delays grow linearly with
 * attempt number (e.g. 2s, 4s, 6s for delay=2000). This matches the
 * fasset-bots pattern and avoids hammering failing servers at constant frequency.
 *
 * @param fn - Async function to execute
 * @param retries - Maximum number of retry attempts (total calls = retries + 1)
 * @param delay - Base delay in milliseconds, scaled by attempt number (default 1000)
 */
export async function retry<T>(fn: () => Promise<T>, retries: number, delay = 1000): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;
            if (attempt < retries) {
                await sleep((attempt + 1) * delay);
            }
        }
    }

    throw lastError;
}

/** Simple sleep helper that resolves after the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
