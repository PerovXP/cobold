import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const maxConcurrentCovers = 2
const maxQueuedCovers = 8
const coverTimeout = 10_000

let activeCovers = 0
const coverQueue: (() => void)[] = []

async function acquireCoverSlot(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted)
        return false
    if (activeCovers < maxConcurrentCovers) {
        activeCovers++
        return true
    }
    if (coverQueue.length >= maxQueuedCovers)
        return false

    return new Promise((resolve) => {
        const onAvailable = () => {
            signal.removeEventListener("abort", onAbort)
            resolve(true)
        }
        function onAbort() {
            const index = coverQueue.indexOf(onAvailable)
            if (index !== -1)
                coverQueue.splice(index, 1)
            resolve(false)
        }
        coverQueue.push(onAvailable)
        signal.addEventListener("abort", onAbort, { once: true })
    })
}

function releaseCoverSlot() {
    const next = coverQueue.shift()
    // Transfer the occupied slot directly to the next waiter.
    if (next)
        next()
    else
        activeCovers--
}

export async function extractVideoCover(file: Uint8Array, duration?: number): Promise<Uint8Array | undefined> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), coverTimeout)
    let acquired = false
    let directory: string | undefined
    try {
        acquired = await acquireCoverSlot(controller.signal)
        if (!acquired)
            return undefined

        controller.signal.throwIfAborted()
        directory = await mkdtemp(join(tmpdir(), "cobold-cover-"))
        const path = join(directory, "video")
        // MP4 files with a trailing moov atom need a seekable input.
        await writeFile(path, file, { signal: controller.signal })
        controller.signal.throwIfAborted()
        return await runFfmpegCover(path, duration, controller.signal)
    } catch {
        // Covers are optional, including when ffmpeg or temporary storage is unavailable.
        return undefined
    } finally {
        clearTimeout(timeout)
        if (directory)
            await rm(directory, { recursive: true, force: true }).catch(() => { /* noop */ })
        if (acquired)
            releaseCoverSlot()
    }
}

async function runFfmpegCover(path: string, duration: number | undefined, signal: AbortSignal): Promise<Uint8Array | undefined> {
    const seek = duration !== undefined && duration > 2 ? "1" : "0"
    return await new Promise((resolve) => {
        const ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", seek, "-i", path, "-frames:v", "1", "-vf", "scale=640:-2", "-pix_fmt", "yuvj420p", "-f", "mjpeg", "pipe:1"], {
            stdio: ["ignore", "pipe", "ignore"],
            signal,
            killSignal: "SIGKILL",
        })
        const chunks: Buffer[] = []
        ffmpeg.stdout.on("data", chunk => chunks.push(chunk))
        ffmpeg.on("error", () => { /* handled on close, including abort and spawn errors */ })
        // Wait for exit before deleting the input and releasing the process slot.
        ffmpeg.on("close", code => resolve(!signal.aborted && code === 0 && chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined))
    })
}
