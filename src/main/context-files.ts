import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { ContextDocInput } from '../shared/types'

/** Parses an uploaded prep file (PDF/MD/TXT) into plain text (R3). */
export async function parseContextFile(filePath: string): Promise<ContextDocInput> {
  const ext = extname(filePath).toLowerCase()
  const name = basename(filePath)
  if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse')
    const buf = await readFile(filePath)
    const parser = new PDFParse({ data: new Uint8Array(buf) })
    try {
      const result = await parser.getText()
      return { name, kind: 'pdf', content: result.text }
    } finally {
      await parser.destroy()
    }
  }
  if (ext === '.md' || ext === '.txt') {
    const content = await readFile(filePath, 'utf8')
    return { name, kind: ext === '.md' ? 'md' : 'txt', content }
  }
  throw new Error(`Unsupported file type: ${ext} (use PDF, MD, or TXT)`)
}
