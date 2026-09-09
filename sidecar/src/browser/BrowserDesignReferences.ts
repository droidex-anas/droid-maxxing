import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { BrowserRuntime } from './BrowserSessionManager.js';
import { browserDesignReferenceDir } from './browserPaths.js';
import { formatDesignPrompt, writeDesignPromptPack } from './designPromptPacks.js';
import type {
  BrowserBox,
  BrowserState,
  DesignAnchor,
  DesignAnchorDetail,
  DesignReference,
  DesignSelectionScreenshot,
} from './types.js';

interface BrowserDesignReferencesOptions {
  appSessionId: string;
  browserSessionId: string;
  runtime: BrowserRuntime;
  browserDataDir?: string;
  writePack?: typeof writeDesignPromptPack;
}

const MAX_PENDING_REFERENCES = 32;
const MAX_PENDING_SCREENSHOTS = 32;

export class BrowserDesignReferences {
  private readonly references = new Map<string, DesignReference>();
  private readonly ownedImagePaths = new Set<string>();
  private readonly packImageClaims = new Map<string, number>();
  private readonly standaloneImagePaths = new Set<string>();
  private currentUrl?: string;
  private generation = 0;
  private isDisposed = false;

  constructor(private readonly options: BrowserDesignReferencesOptions) {}

  async add(
    state: BrowserState,
    input: { anchor: DesignAnchor; detail?: DesignAnchorDetail; id?: string },
    screenshot?: DesignSelectionScreenshot,
  ): Promise<DesignReference> {
    await this.navigate(state.url);
    const expectedGeneration = this.generation;
    const id = input.id ?? input.anchor.id;
    const anchor: DesignAnchor = { ...input.anchor, id };
    const detail = input.detail ? { ...input.detail, id } : undefined;
    if (!anchor.screenshotPath) {
      const crop = await this.captureAnchor(anchor.box).catch(() => undefined);
      if (crop) anchor.screenshotPath = crop;
    }
    if (
      this.isDisposed ||
      this.generation !== expectedGeneration ||
      this.currentUrl !== state.url
    ) {
      await this.deleteOwnedImagePaths(anchor.screenshotPath ? [anchor.screenshotPath] : []);
      throw new Error(
        this.isDisposed
          ? 'Browser design reference was canceled because the session closed.'
          : 'Browser design reference was canceled because the page changed.',
      );
    }
    const reference: DesignReference = {
      id,
      anchor,
      detail,
      url: state.url,
      title: state.title,
      viewport: state.viewport,
      scroll: state.scroll,
      screenshot,
      createdAt: new Date().toISOString(),
    };
    const previous = this.references.get(id);
    this.references.delete(id);
    this.references.set(id, reference);
    if (previous) await this.deleteOwnedImages([previous]);
    await this.trimReferences();
    return reference;
  }

  async navigate(url: string): Promise<void> {
    if (this.isDisposed) throw new Error('Browser design reference session is closed.');
    if (this.currentUrl === undefined) {
      this.currentUrl = url;
      return;
    }
    if (url === this.currentUrl) return;
    this.currentUrl = url;
    this.generation += 1;
    const previous = [...this.references.values()];
    const previousStandaloneImages = [...this.standaloneImagePaths];
    this.references.clear();
    await this.deleteOwnedImages(previous);
    await this.deleteOwnedImagePaths(previousStandaloneImages);
  }

  detail(id: string): DesignReference | undefined {
    return this.references.get(id);
  }

  all(): DesignReference[] {
    return [...this.references.values()];
  }

  async prompt(
    instructionValue: string,
    referenceIds: string[],
  ): Promise<{
    path: string;
    prompt: string;
  }> {
    const instruction = instructionValue.trim();
    if (!instruction) throw new Error('Browser prompt cannot be empty.');
    const references = referenceIds
      .map((id) => this.references.get(id))
      .filter((reference): reference is DesignReference => Boolean(reference));
    if (references.length === 0) {
      throw new Error(
        'Select or sketch at least one browser reference before sending a Design Mode prompt.',
      );
    }
    const imagePaths = references.flatMap((reference) =>
      reference.anchor.screenshotPath ? [reference.anchor.screenshotPath] : [],
    );
    this.claimPackImages(imagePaths);
    try {
      const { path } = await (this.options.writePack ?? writeDesignPromptPack)({
        appSessionId: this.options.appSessionId,
        browserSessionId: this.options.browserSessionId,
        instruction,
        references,
      });
      for (const imagePath of imagePaths) {
        this.ownedImagePaths.delete(imagePath);
        this.standaloneImagePaths.delete(imagePath);
      }
      return { path, prompt: formatDesignPrompt(path, instruction, references) };
    } finally {
      this.releasePackImages(imagePaths);
      await this.deleteOwnedImagePaths(imagePaths);
    }
  }

  async saveImage(name: string, base64: string): Promise<string> {
    if (this.isDisposed) throw new Error('Browser design reference session is closed.');
    const expectedGeneration = this.generation;
    const path = await this.persist(name, base64);
    if (this.generation !== expectedGeneration) {
      await this.deleteOwnedImagePaths([path]);
      throw new Error('Browser screenshot was canceled because the page or session changed.');
    }
    this.standaloneImagePaths.add(path);
    await this.trimStandaloneImages();
    return path;
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.generation += 1;
    const previous = [...this.references.values()];
    this.references.clear();
    await this.deleteOwnedImages(previous);
    await this.deleteOwnedImagePaths([...this.ownedImagePaths]);
  }

  private async captureAnchor(box?: BrowserBox): Promise<string | undefined> {
    const base64 = await this.options.runtime.capture(box);
    if (!base64) return undefined;
    const tag = box ? [box.x, box.y, box.width, box.height].join('-') : 'view';
    return this.persist(`anchor-${tag}-${Date.now().toString(36)}.png`, base64);
  }

  private async persist(name: string, base64: string): Promise<string> {
    const directory = browserDesignReferenceDir(
      this.options.appSessionId,
      this.options.browserDataDir,
    );
    await mkdir(directory, { recursive: true });
    const safeName = basename(name);
    const extension = extname(safeName);
    const stem = extension ? safeName.slice(0, -extension.length) : safeName;
    const path = join(directory, `${stem}-${randomUUID()}${extension}`);
    await writeFile(path, Buffer.from(base64, 'base64'));
    this.ownedImagePaths.add(path);
    return path;
  }

  private async deleteOwnedImages(references: DesignReference[]): Promise<void> {
    await this.deleteOwnedImagePaths(
      references.flatMap((reference) =>
        reference.anchor.screenshotPath ? [reference.anchor.screenshotPath] : [],
      ),
    );
  }

  private async deleteOwnedImagePaths(imagePaths: string[]): Promise<void> {
    for (const imagePath of new Set(imagePaths)) {
      if (!this.ownedImagePaths.has(imagePath)) {
        this.standaloneImagePaths.delete(imagePath);
        continue;
      }
      if (
        [...this.references.values()].some(
          (current) => current.anchor.screenshotPath === imagePath,
        ) ||
        this.packImageClaims.has(imagePath)
      ) {
        continue;
      }
      try {
        await unlink(imagePath);
        this.ownedImagePaths.delete(imagePath);
        this.standaloneImagePaths.delete(imagePath);
      } catch (error) {
        if (isMissingFileError(error)) {
          this.ownedImagePaths.delete(imagePath);
          this.standaloneImagePaths.delete(imagePath);
        } else {
          console.error('Failed to delete browser design image.', error);
        }
      }
    }
  }

  private claimPackImages(imagePaths: string[]): void {
    for (const imagePath of imagePaths) {
      this.packImageClaims.set(imagePath, (this.packImageClaims.get(imagePath) ?? 0) + 1);
    }
  }

  private releasePackImages(imagePaths: string[]): void {
    for (const imagePath of imagePaths) {
      const claims = this.packImageClaims.get(imagePath) ?? 0;
      if (claims <= 1) this.packImageClaims.delete(imagePath);
      else this.packImageClaims.set(imagePath, claims - 1);
    }
  }

  private async trimReferences(): Promise<void> {
    while (this.references.size > MAX_PENDING_REFERENCES) {
      const oldest = this.references.values().next().value;
      if (!oldest) return;
      this.references.delete(oldest.id);
      await this.deleteOwnedImages([oldest]);
    }
  }

  private async trimStandaloneImages(): Promise<void> {
    while (this.standaloneImagePaths.size > MAX_PENDING_SCREENSHOTS) {
      const oldest = [...this.standaloneImagePaths].find(
        (imagePath) =>
          !this.packImageClaims.has(imagePath) &&
          ![...this.references.values()].some(
            (reference) => reference.anchor.screenshotPath === imagePath,
          ),
      );
      if (!oldest) return;
      const previousSize = this.standaloneImagePaths.size;
      await this.deleteOwnedImagePaths([oldest]);
      if (this.standaloneImagePaths.size === previousSize) return;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
