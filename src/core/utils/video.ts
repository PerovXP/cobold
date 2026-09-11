import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"

const maxConcurrentCovers = 2
const coverTimeout = 10_000

let activeCovers = 0
const coverQueue: (() => void)[] = []

async function acquireCoverSlot() {
    if (activeCovers >= maxConcurrentCovers)
        await new Promise<void>(resolve => coverQueue.push(resolve))
    activeCovers++
}

function releaseCoverSlot() {
    activeCovers--
    coverQueue.shift()?.()
}

export async function extractVideoCover(file: Uint8Array, duration?: number): Promise<Uint8Array | undefined> {
    await acquireCoverSlot()
    try {
        return await runFfmpegCover(file, duration)
    } finally {
        releaseCoverSlot()
    }
}

async function runFfmpegCover(file: Uint8Array, duration?: number): Promise<Uint8Array | undefined> {
    const seek = duration !== undefined && duration > 2 ? "1" : "0"
    return await new Promise((resolve) => {
        const ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ss", seek, "-frames:v", "1", "-vf", "scale=640:-2", "-pix_fmt", "yuvj420p", "-f", "mjpeg", "pipe:1"])
        const chunks: Buffer[] = []
        const killTimer = setTimeout(() => {
            ffmpeg.kill("SIGKILL")
            ffmpeg.unref()
            resolve(undefined)
        }, coverTimeout)

        const done = (result: Uint8Array | undefined) => {
            clearTimeout(killTimer)
            resolve(result)
        }

        ffmpeg.stdout.on("data", chunk => chunks.push(chunk))
        ffmpeg.on("error", () => done(undefined))
        ffmpeg.on("close", code => done(code === 0 && chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined))
        ffmpeg.stdin.on("error", () => { /* noop */ })
        ffmpeg.stdin.end(file)
    })
}
