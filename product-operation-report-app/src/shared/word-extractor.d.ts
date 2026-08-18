declare module 'word-extractor' {
  interface ExtractedWordDocument {
    getBody(): string
    getHeaders(): string
    getFooters(): string
    getAnnotations(): string
    getTextboxes(options?: { includeHeadersAndFooters?: boolean; includeBody?: boolean }): string
  }

  export default class WordExtractor {
    extract(source: Buffer | string): Promise<ExtractedWordDocument>
  }
}
