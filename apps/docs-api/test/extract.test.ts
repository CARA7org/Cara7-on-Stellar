import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractText, isSupportedExtension } from '../src/lib/extract.js';

let fixturesDirectory: string;

beforeAll(async () => {
  fixturesDirectory = await mkdtemp(path.join(tmpdir(), 'cara7-test-'));
});

describe('isSupportedExtension', () => {
  it('accepts the announced formats and refuses the rest', () => {
    expect(isSupportedExtension('.pdf')).toBe(true);
    expect(isSupportedExtension('.docx')).toBe(true);
    expect(isSupportedExtension('.xlsx')).toBe(true);
    expect(isSupportedExtension('.exe')).toBe(false);
    expect(isSupportedExtension('')).toBe(false);
  });
});

describe('extractText', () => {
  it('reads a text file', async () => {
    const filePath = path.join(fixturesDirectory, 'note.txt');
    await writeFile(filePath, 'Content of the test note.');
    const result = await extractText(filePath, 'note.txt');
    expect(result.text).toBe('Content of the test note.');
    expect(result.pages).toBeUndefined();
  });

  it('extracts every sheet of an xlsx workbook', async () => {
    const filePath = path.join(fixturesDirectory, 'sales.xlsx');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['Client', 'Amount'],
        ['Dupont SA', 4500],
      ]),
      'Sales',
    );
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Quarter'], ['Q1']]), 'Calendar');
    await writeFile(filePath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));

    const result = await extractText(filePath, 'sales.xlsx');
    expect(result.text).toContain('Sheet: Sales');
    expect(result.text).toContain('Dupont SA');
    expect(result.text).toContain('Sheet: Calendar');
  });

  it('reads a csv', async () => {
    const filePath = path.join(fixturesDirectory, 'clients.csv');
    await writeFile(filePath, 'name,city\nMartin,Bordeaux\n');
    const result = await extractText(filePath, 'clients.csv');
    expect(result.text).toContain('Martin');
    expect(result.text).toContain('Bordeaux');
  });

  it('indexes the readable content of a zip, one header per file', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('docs/README.md', Buffer.from('# Test scaffold\nReusable part of the project.'));
    zip.addFile('data/clients.csv', Buffer.from('name,city\nMartin,Bordeaux\n'));
    zip.addFile('node_modules/lib/index.js', Buffer.from('skip-me'));
    zip.addFile('package-lock.json', Buffer.from('{"ignore": true}'));
    zip.addFile('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const filePath = path.join(fixturesDirectory, 'scaffold.zip');
    await writeFile(filePath, zip.toBuffer());

    const result = await extractText(filePath, 'scaffold.zip');
    expect(result.text).toContain('===== docs/README.md =====');
    expect(result.text).toContain('Reusable part');
    expect(result.text).toContain('===== data/clients.csv =====');
    expect(result.text).toContain('Martin');
    expect(result.text).not.toContain('skip-me');
    expect(result.text).not.toContain('"ignore": true');
  });

  it('rejects an unknown format', async () => {
    const filePath = path.join(fixturesDirectory, 'program.exe');
    await writeFile(filePath, 'binary');
    await expect(extractText(filePath, 'program.exe')).rejects.toThrow('Unsupported format');
  });
});
