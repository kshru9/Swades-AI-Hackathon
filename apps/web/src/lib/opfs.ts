const ROOT_FOLDER = "recordings"
const SEQUENCE_PAD = 4

let rootHandlePromise: Promise<FileSystemDirectoryHandle> | null = null
const recordingDirectoryCache = new Map<string, Promise<FileSystemDirectoryHandle>>()

function getChunkFileName(sequenceNo: number, chunkId: string) {
  return `${String(sequenceNo).padStart(SEQUENCE_PAD, "0")}-${chunkId}.wav`
}

async function getRootHandle() {
  if (!rootHandlePromise) {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
      throw new Error("OPFS is not available in this environment")
    }
    rootHandlePromise = navigator.storage.getDirectory()
  }
  return rootHandlePromise
}

async function getRecordingHandle(recordingId: string) {
  let handlePromise = recordingDirectoryCache.get(recordingId)
  if (!handlePromise) {
    handlePromise = (async () => {
      const root = await getRootHandle()
      const recordings = await root.getDirectoryHandle(ROOT_FOLDER, { create: true })
      return recordings.getDirectoryHandle(recordingId, { create: true })
    })()
    recordingDirectoryCache.set(recordingId, handlePromise)
  }
  return handlePromise
}

export async function saveChunkToOpfs(
  recordingId: string,
  sequenceNo: number,
  chunkId: string,
  blob: Blob
) {
  const recordingHandle = await getRecordingHandle(recordingId)
  const fileName = getChunkFileName(sequenceNo, chunkId)
  const fileHandle = await recordingHandle.getFileHandle(fileName, { create: true })
  const writable = await fileHandle.createWritable()
  try {
    await writable.write(blob)
  } finally {
    await writable.close()
  }
  return `${ROOT_FOLDER}/${recordingId}/${fileName}`
}

export async function readChunkFromOpfs(
  recordingId: string,
  sequenceNo: number,
  chunkId: string
) {
  const recordingHandle = await getRecordingHandle(recordingId)
  const fileName = getChunkFileName(sequenceNo, chunkId)
  const fileHandle = await recordingHandle.getFileHandle(fileName)
  return await fileHandle.getFile()
}
