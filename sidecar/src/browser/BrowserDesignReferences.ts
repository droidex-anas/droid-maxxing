import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

export class BrowserDesignReferences {
  private readonly references = new Map<string, DesignReference>();

  constructor(private readonly options: BrowserDesignReferencesOptions) {}

  async add(
    state: BrowserState,
    input: { anchor: DesignAnchor; detail?: DesignAnchorDetail; id?: string },
    screenshot?: DesignSelectionScreenshot,
  ): Promise<DesignReference> {
    const id = input.id ?? input.anchor.id;
    const anchor: DesignAnchor = { ...input.anchor, id };
    const detail = input.detail ? { ...input.detail, id } : undefined;
    if (!anchor.screenshotPath) {
      const crop = await this.captureAnchor(anchor.box).catch(() => undefined);
      if (crop) anchor.screenshotPath = crop;
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
    this.references.set(id, reference);
    return reference;
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
    const { path } = await (this.options.writePack ?? writeDesignPromptPack)({
      appSessionId: this.options.appSessionId,
      browserSessionId: this.options.browserSessionId,
      instruction,
      references,
    });
    return { path, prompt: formatDesignPrompt(path, instruction, references) };
  }

  saveImage(name: string, base64: string): Promise<string> {
    return this.persist(name, base64);
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
    const path = join(directory, name);
    await writeFile(path, Buffer.from(base64, 'base64'));
    return path;
  }
}
