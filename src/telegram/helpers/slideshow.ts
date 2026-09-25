import type { InlineCallbackQueryContext } from "@mtcute/dispatcher"
import type { InputMediaLike, InputMediaPhoto, Peer, Photo, tl } from "@mtcute/node"

import { Rich } from "@mtcute/node"

const maxRichMedia = 50
const uploadBatchSize = 4

export async function editInlineSlideshow(
    client: InlineCallbackQueryContext["client"],
    inlineMessageId: tl.TypeInputBotInlineMessageID,
    medias: InputMediaLike[],
    uploadPeer: Peer,
    sourceUrl?: string,
): Promise<boolean> {
    const photos = medias.filter((media): media is InputMediaPhoto =>
        typeof media === "object" && media !== null && "type" in media && media.type === "photo")
    if (photos.length < 2 || photos.length > maxRichMedia || photos.length !== medias.length)
        return false

    const uploaded: Photo[] = []
    for (let i = 0; i < photos.length; i += uploadBatchSize) {
        const batch = await Promise.all(photos.slice(i, i + uploadBatchSize).map(async (photo): Promise<Photo> => {
            const media = await client.uploadMedia(photo, { peer: uploadPeer })
            if (!("inputPhoto" in media))
                throw new Error("Telegram did not return an uploaded photo")
            return media
        }))
        uploaded.push(...batch)
    }

    await client.editInlineMessage({
        messageId: inlineMessageId,
        richMessage: {
            type: "blocks",
            blocks: [Rich.slideshow(uploaded.map(photo => Rich.photo(photo.inputPhoto)), sourceUrl)],
        },
    })
    return true
}
