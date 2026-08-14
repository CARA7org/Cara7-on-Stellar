import path from 'node:path';
import { readFile } from 'node:fs/promises';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { PDFParse } from 'pdf-parse';
import WordExtractor from 'word-extractor';
import AdmZip from 'adm-zip';

const wordExtractor = new WordExtractor();

export const SUPPORTED_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.doc',
  '.xlsx',
  '.xls',
  '.csv',
  '.txt',
  '.md',
  '.zip',
] as const;

// Inside a zip: documents plus the usual text and code files of a repo.
const ZIP_TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.csv', '.json', '.yml', '.yaml', '.toml',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sql', '.prisma', '.sol', '.rs', '.py', '.sh', '.env.example',
]);
const ZIP_BINARY_DOC_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls']);
// Repo noise to skip inside a zip.
const ZIP_SKIP_PATTERN =
  /(^|\/)(node_modules|\.git|\.next|dist|build|target|__MACOSX)\/|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.lock$|\.DS_Store|\.map$|\.min\./;
const ZIP_ENTRY_CHAR_LIMIT = 200_000; // per inner file
const ZIP_TOTAL_CHAR_LIMIT = 2_000_000; // per archive

export interface ExtractionResult {
  text: string;
  pages?: number;
}

export function isSupportedExtension(extension: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extension);
}

async function extractPdfBuffer(buffer: Buffer): Promise<ExtractionResult> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return { text: result.text, pages: result.total };
  } finally {
    await parser.destroy();
  }
}

function extractSpreadsheetBuffer(buffer: Buffer): ExtractionResult {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheets: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv.trim()) sheets.push(`Sheet: ${sheetName}\n${csv}`);
  }
  return { text: sheets.join('\n\n') };
}

async function extractDocumentBuffer(buffer: Buffer, extension: string): Promise<ExtractionResult> {
  switch (extension) {
    case '.pdf':
      return extractPdfBuffer(buffer);
    case '.docx': {
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value };
    }
    case '.doc': {
      const extractedDocument = await wordExtractor.extract(buffer);
      return { text: extractedDocument.getBody() };
    }
    case '.xlsx':
    case '.xls':
    case '.csv':
      return extractSpreadsheetBuffer(buffer);
    default:
      return { text: buffer.toString('utf8') };
  }
}

/// Zip archive: the readable content (documents plus text and code) is
/// extracted file by file, each section preceded by its inner path. Repo
/// noise (node_modules, locks, binaries) is skipped.
async function extractZip(filePath: string): Promise<ExtractionResult> {
  const zip = new AdmZip(filePath);
  const sections: string[] = [];
  let totalChars = 0;
  let skippedEntries = 0;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const entryName = entry.entryName;
    if (ZIP_SKIP_PATTERN.test(entryName)) continue;
    const extension = path.extname(entryName).toLowerCase();
    const isTextual = ZIP_TEXT_EXTENSIONS.has(extension) || entryName.endsWith('.env.example');
    const isBinaryDocument = ZIP_BINARY_DOC_EXTENSIONS.has(extension);
    if (!isTextual && !isBinaryDocument) continue;
    if (totalChars >= ZIP_TOTAL_CHAR_LIMIT) {
      skippedEntries++;
      continue;
    }

    try {
      const buffer = entry.getData();
      if (buffer.length === 0 || buffer.length > 20 * 1024 * 1024) continue;
      const extracted = isBinaryDocument
        ? await extractDocumentBuffer(buffer, extension)
        : { text: buffer.toString('utf8') };
      const trimmed = extracted.text.trim().slice(0, ZIP_ENTRY_CHAR_LIMIT);
      if (!trimmed) continue;
      sections.push(`===== ${entryName} =====\n${trimmed}`);
      totalChars += trimmed.length;
    } catch {
      skippedEntries++; // unreadable inner file: keep going
    }
  }

  if (skippedEntries > 0) {
    sections.push(`===== (archive) =====\n${skippedEntries} file(s) not indexed (unreadable, or limit reached).`);
  }
  return { text: sections.join('\n\n') };
}

export async function extractText(filePath: string, originalName: string): Promise<ExtractionResult> {
  const extension = path.extname(originalName).toLowerCase();

  switch (extension) {
    case '.pdf':
      return extractPdfBuffer(await readFile(filePath));

    case '.docx': {
      const result = await mammoth.extractRawText({ path: filePath });
      return { text: result.value };
    }

    case '.doc': {
      const extractedDocument = await wordExtractor.extract(filePath);
      return { text: extractedDocument.getBody() };
    }

    case '.xlsx':
    case '.xls':
    case '.csv':
      return extractSpreadsheetBuffer(await readFile(filePath));

    case '.txt':
    case '.md':
      return { text: await readFile(filePath, 'utf8') };

    case '.zip':
      return extractZip(filePath);

    default:
      throw new Error(`Unsupported format: ${extension || '(no extension)'}`);
  }
}
