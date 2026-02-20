interface HttpGetOptions {
    retries?: number
    retryDelaySeconds?: number
}

function HttpGet(
    url: string,
    options?: HttpGetOptions
): LuaTuple<[boolean, string]> {
    const retries = math.max(options?.retries ?? 0, 0)
    const retryDelaySeconds = options?.retryDelaySeconds ?? 0.15

    const request = game as DataModel & { HttpGet(url: string): string }
    let lastError = "request failed"

    for (let attempt = 0; attempt <= retries; attempt++) {
        const [ok, resultOrError] = pcall(() => request.HttpGet(url))

        if (ok) {
            return [true, resultOrError as string] as LuaTuple<[boolean, string]>
        }

        lastError = tostring(resultOrError)

        if (attempt < retries) {
            task.wait(retryDelaySeconds)
        }
    }

    return [false, lastError] as LuaTuple<[boolean, string]>
}

export = HttpGet
