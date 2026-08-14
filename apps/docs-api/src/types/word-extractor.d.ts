declare module 'word-extractor' {
  class ExtractedDocument {
    getBody(): string;
  }

  export default class WordExtractor {
    extract(source: string | Buffer): Promise<ExtractedDocument>;
  }
}
