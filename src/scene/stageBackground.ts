import { create } from 'zustand'
import * as THREE from 'three'
import {
  registerStageBackgroundBridge,
  useStore,
  type StageBackgroundSnapshot,
} from '../store'

/**
 * Project-level stage background image.
 *
 * The decoded GPU texture and source bytes intentionally live outside the
 * serialisable Settings object. This mirrors the note-texture store while
 * keeping the background static: no animation clock or ImageDecoder path
 * is involved.
 */

export const STAGE_BACKGROUND_ACCEPTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const

const ACCEPTED_TYPES = new Set<string>(STAGE_BACKGROUND_ACCEPTED_TYPES)

type StageBackgroundStore = {
  texture: THREE.Texture | null
  fileName: string | null
  fileBytes: ArrayBuffer | null
  fileMime: string | null
  imageAspect: number
  setFromFile: (file: File | null) => Promise<void>
  setFromBytes: (bytes: ArrayBuffer, mime: string, fileName: string) => Promise<void>
  clearFromLoad: () => void
}

type StageBackgroundState = Pick<
  StageBackgroundStore,
  'texture' | 'fileName' | 'fileBytes' | 'fileMime' | 'imageAspect'
>

let committedState: StageBackgroundState = {
  texture: null,
  fileName: null,
  fileBytes: null,
  fileMime: null,
  imageAspect: 1,
}

const snapshotCommitted = (): StageBackgroundSnapshot => ({
  bytes: committedState.fileBytes,
  mime: committedState.fileMime,
  fileName: committedState.fileName,
})

function guessMimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png' || ext === 'apng') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'avif') return 'image/avif'
  return ''
}

function normalizeMime(mime: string, fileName: string): string {
  const normalized = (mime || guessMimeFromName(fileName)).toLowerCase()
  if (normalized === 'image/jpg') return 'image/jpeg'
  if (normalized === 'image/x-png') return 'image/png'
  return normalized
}

function imageAspectOf(texture: THREE.Texture): number {
  const image = texture.image as {
    naturalWidth?: number
    naturalHeight?: number
    width?: number
    height?: number
  } | null
  const width = image?.naturalWidth ?? image?.width ?? 1
  const height = image?.naturalHeight ?? image?.height ?? 1
  return width > 0 && height > 0 ? width / height : 1
}

export const useStageBackground = create<StageBackgroundStore>((set) => {
  let loadGeneration = 0

  const clear = () => {
    loadGeneration++
    committedState.texture?.dispose()
    committedState = {
      texture: null,
      fileName: null,
      fileBytes: null,
      fileMime: null,
      imageAspect: 1,
    }
    set(committedState)
  }

  const loadFromBytes = async (
    bytes: ArrayBuffer,
    mime: string,
    fileName: string,
    generation: number,
  ): Promise<boolean> => {
    // A newer selection/load supersedes this one before decoding starts.
    if (generation !== loadGeneration) return false

    const normalizedMime = normalizeMime(mime, fileName)
    if (!ACCEPTED_TYPES.has(normalizedMime)) {
      throw new Error('Unsupported background image type. Use JPEG, PNG, WebP, or AVIF.')
    }

    if (generation !== loadGeneration) return false

    // Publish metadata immediately so project saves that happen while a
    // large image is decoding still contain the original bytes. The GPU
    // texture only becomes visible after the decode commits below.
    const previousCommitted = committedState
    set({ fileName, fileBytes: bytes, fileMime: normalizedMime })

    const blob = new Blob([bytes], { type: normalizedMime })
    const url = URL.createObjectURL(blob)
    let texture: THREE.Texture
    try {
      texture = await new THREE.TextureLoader().loadAsync(url)
    } catch (error) {
      if (generation !== loadGeneration) return false
      // Restore the last successfully decoded image after a current-load
      // failure. Stale failures are ignored so an older rejected file
      // cannot overwrite a newer successful selection.
      set(previousCommitted)
      throw error
    } finally {
      URL.revokeObjectURL(url)
    }

    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = THREE.ClampToEdgeWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    texture.needsUpdate = true

    if (generation !== loadGeneration) {
      texture.dispose()
      return false
    }

    const nextState: StageBackgroundState = {
      texture,
      fileName,
      fileBytes: bytes,
      fileMime: normalizedMime,
      imageAspect: imageAspectOf(texture),
    }
    committedState = nextState
    set(nextState)
    previousCommitted.texture?.dispose()
    return true
  }

  return {
    texture: null,
    fileName: null,
    fileBytes: null,
    fileMime: null,
    imageAspect: 1,
    setFromFile: async (file) => {
      const generation = ++loadGeneration
      const before = snapshotCommitted()
      // Drop metadata published by an older in-flight decode before
      // waiting for this file's bytes, so a save during the arrayBuffer
      // read cannot capture a superseded selection.
      set(committedState)
      if (!file) {
        clear()
      } else {
        let bytes: ArrayBuffer
        try {
          bytes = await file.arrayBuffer()
        } catch (error) {
          if (generation !== loadGeneration) return
          throw error
        }
        const applied = await loadFromBytes(bytes, file.type, file.name, generation)
        if (!applied) return
      }
      const after = snapshotCommitted()
      const changed =
        before.bytes !== after.bytes ||
        before.mime !== after.mime ||
        before.fileName !== after.fileName
      if (changed) {
        useStore.getState().pushStageBackgroundSnapshot(before)
        useStore.getState().markDirty()
      }
    },
    setFromBytes: async (bytes, mime, fileName) => {
      const generation = ++loadGeneration
      await loadFromBytes(bytes, mime, fileName, generation)
    },
    clearFromLoad: () => clear(),
  }
})

registerStageBackgroundBridge(
  snapshotCommitted,
  (snapshot) => {
    const store = useStageBackground.getState()
    if (snapshot.bytes && snapshot.mime && snapshot.fileName) {
      void store
        .setFromBytes(snapshot.bytes, snapshot.mime, snapshot.fileName)
        .catch(() => store.clearFromLoad())
    } else {
      store.clearFromLoad()
    }
  },
)
