import { describe, it, expect } from 'vitest';
import { sniffFileKind, isImageKind, describeBytes } from '../src/index.js';

const bytes = (...values: Array<number | string>): Uint8Array => {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === 'number') out.push(value);
    else for (const ch of value) out.push(ch.charCodeAt(0));
  }
  return new Uint8Array(out.concat(new Array(Math.max(0, 32 - out.length)).fill(0)));
};

describe('sniffFileKind', () => {
  it('reads the formats the pipeline accepts out of their leading bytes', () => {
    expect(sniffFileKind(bytes('glTF', 2, 0, 0, 0))).toBe('glb');
    expect(sniffFileKind(bytes(0x89, 'PNG', 0x0d, 0x0a))).toBe('png');
    expect(sniffFileKind(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(sniffFileKind(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('webp');
    expect(sniffFileKind(bytes('GIF89a'))).toBe('gif');
    expect(sniffFileKind(bytes('BM', 0, 0))).toBe('bmp');
    expect(sniffFileKind(bytes(0x49, 0x49, 0x2a, 0x00))).toBe('tiff');
    expect(sniffFileKind(bytes('<svg viewBox="0 0 1 1">'))).toBe('svg');
    expect(sniffFileKind(bytes('#usda 1.0'))).toBe('usda');
    expect(sniffFileKind(bytes('PXR-USDC'))).toBe('usdc');
  });

  it('identifies an iPhone camera-roll photo by its ftyp brand', () => {
    // The case the whole module exists for: iOS hands over HEIC with no
    // extension and an empty MIME type when nothing asks it to transcode.
    expect(sniffFileKind(bytes(0, 0, 0, 0x18, 'ftyp', 'heic'))).toBe('heic');
    expect(sniffFileKind(bytes(0, 0, 0, 0x18, 'ftyp', 'heix'))).toBe('heic');
    expect(sniffFileKind(bytes(0, 0, 0, 0x18, 'ftyp', 'mif1'))).toBe('heic');
    expect(sniffFileKind(bytes(0, 0, 0, 0x18, 'ftyp', 'avif'))).toBe('avif');
    expect(isImageKind(sniffFileKind(bytes(0, 0, 0, 0x18, 'ftyp', 'heic')))).toBe(true);
  });

  it('tells a glTF JSON from any other JSON', () => {
    expect(sniffFileKind(bytes('{"asset": {"version": "2.0"}}'))).toBe('gltf');
    expect(sniffFileKind(bytes('{"hello": "world"}'))).toBe('unknown');
  });

  it('only claims a zip it can see a USD layer inside', () => {
    const zip = (name: string) => bytes(0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, name);
    expect(sniffFileKind(zip('model.usdc'))).toBe('usdz');
    expect(sniffFileKind(zip('notes.txt'))).toBe('unknown');
  });

  it('says unknown rather than guessing, and describes what it saw', () => {
    expect(sniffFileKind(bytes(0xde, 0xad, 0xbe, 0xef))).toBe('unknown');
    expect(sniffFileKind(new Uint8Array(0))).toBe('unknown');
    expect(describeBytes(bytes(0xde, 0xad, 0xbe, 0xef))).toContain('de ad be ef');
    expect(describeBytes(new Uint8Array(0))).toBe('the file is empty');
  });

  it('classifies image kinds, and does not call a GLB one', () => {
    expect(isImageKind('png')).toBe(true);
    expect(isImageKind('heic')).toBe(true);
    expect(isImageKind('svg')).toBe(true);
    expect(isImageKind('glb')).toBe(false);
    expect(isImageKind('unknown')).toBe(false);
  });
});
