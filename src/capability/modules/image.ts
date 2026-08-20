/**
 * Beckett v6 — the image extension (`src/capability/modules/image.ts`)
 * =======================================================================================
 * The first organ on the v6 extension contract (Phase 1, docs/v6-architecture.md §6): the
 * `beckett image …` surface (in-process generation via `agency/imagegen.ts` — Codex by
 * default, `--model fal-ai/...` routes to the fal.ai queue, `--model openrouter/...` routes
 * to OpenRouter).
 *
 * Two entrypoints share ONE core (`generateMedia`):
 *   - the CLI verb keeps its historical argv parse + `out`/`fail` contract byte-for-byte
 *     (the CLI characterization suite pins it), and
 *   - `image.generate` is the v6 capability: zod-validated structured args in, an
 *     {@link ExtensionResult} out — never `out`/`fail` (those exit the process), so the
 *     concierge can dispatch it in-daemon once its call site cuts over (Phase 2+).
 *
 * `createImageCapability` remains for the v5 factory table: it is the {@link asCapability}
 * projection of this extension, and retires with the table in Phase 4.
 */

import { z } from "zod";
import { ActionClass, type Extension, type ExtensionFactory } from "../../ext/contract.ts";
import { asCapability } from "../../ext/compat.ts";
import type { Capability, CapabilityDeps } from "../index.ts";
import { CodexImageGen, type ImageGenOptions, type ImageGenResult } from "../../agency/imagegen.ts";
import { fail, out, parse } from "../../cli/io.ts";

/** The validated shape of an `image.generate` call — the registry checks args against this. */
const GenerateArgs = z
  .object({
    prompt: z.string().trim().min(1, "image.generate needs a non-empty prompt"),
    /** File path to save to; default <imagesDir>/<ts>-<slug>.png. */
    out: z.string().optional(),
    /** 1024x1024 (default) | 1536x1024 | 1024x1536 | auto. */
    size: z.string().optional(),
    /** Reference image paths to edit / build on. */
    refs: z.array(z.string()).optional(),
    /** Ask for a transparent (alpha) background. */
    transparent: z.boolean().optional(),
    /** Codex model override, or a fal-ai/... or openrouter/... slug to route elsewhere. */
    model: z.string().optional(),
    /** Generate a video instead of an image (fal only). */
    video: z.boolean().optional(),
  })
  .refine((a) => !a.video || (a.model ?? "").startsWith("fal-ai/"), {
    message: 'video generation requires a fal video model, e.g. model "fal-ai/bytedance/seedance/..."',
  });

export const createImageExtension: ExtensionFactory = ({ paths, logger }): Extension => {
  /** The one generation core both entrypoints call. Throws on failure — surfaces adapt. */
  function generateMedia(opts: ImageGenOptions): Promise<ImageGenResult> {
    return new CodexImageGen({ imagesDir: paths.imagesDir, logger }).generate(opts);
  }

  // The former `cli/beckett.ts::runImage`, byte-identical in observable behavior.
  async function runImage(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    const video = sub === "video";
    const { _, flags } = parse((video ? rest : [sub, ...rest]).filter(Boolean) as string[]);
    const prompt = _.join(" ").trim();
    if (!prompt)
      fail(
        'usage: beckett image [video] "<prompt>" [--out <path>] [--size 1024x1024|1536x1024|1024x1536|auto] [--ref <file[,file]>] [--transparent] [--model <codex-model|fal-ai/...|openrouter/...>]',
      );
    if (video && !String(flags.model ?? "").startsWith("fal-ai/")) {
      fail('beckett image video requires a fal video model, e.g. --model "fal-ai/bytedance/seedance/..."');
    }
    const refs = flags.ref ? String(flags.ref).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    out(
      await generateMedia({
        prompt,
        out: flags.out ? String(flags.out) : undefined,
        size: flags.size ? String(flags.size) : undefined,
        refs,
        transparent: flags.transparent === true || flags.transparent === "true",
        model: flags.model ? String(flags.model) : undefined,
        media: video ? "video" : undefined,
      }),
    );
  }

  return {
    manifest: {
      id: "image",
      version: "1.0.0",
      summary:
        "in-process image/video generation (Codex by default — auto-falls back to fal if codex " +
        "isn't on PATH; fal-ai/... routes to fal, openrouter/... routes to OpenRouter)",
      actionClass: ActionClass.FREE,
      kind: "extension",
    },

    // --- v6 discovery + dispatch ---
    capabilities: [
      {
        id: "image.generate",
        description:
          "Generate or edit a raster image — a logo, banner, sprite, illustration, mockup " +
          "graphic, or any \"make me a picture of…\" ask. Codex renders by default; pass a " +
          "fal-ai/... model to route to the fal queue instead (required for video), or an " +
          "openrouter/... model (e.g. openrouter/google/gemini-2.5-flash-image) to route to " +
          "OpenRouter. Reference images turn the call into an edit. Returns the saved file path.",
        input: GenerateArgs,
        examples: [
          "make a logo for the docs site",
          "generate a 1536x1024 banner with a transparent background",
          "edit this screenshot to highlight the button",
        ],
      },
    ],
    invoke: async (call) => {
      if (call.capabilityId !== "image.generate") {
        return { ok: false, error: `image: unknown capability "${call.capabilityId}"` };
      }
      // Args are already validated by the registry against GenerateArgs.
      const a = call.args as z.infer<typeof GenerateArgs>;
      try {
        const result = await generateMedia({
          prompt: a.prompt,
          out: a.out,
          size: a.size,
          refs: a.refs,
          transparent: a.transparent,
          model: a.model,
          media: a.video ? "video" : undefined,
        });
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    // --- v5 facets, carried through unchanged ---
    cliHelp: "image",
    skillDoc: ".claude/skills/image/SKILL.md",
    cliVerbs: [
      {
        name: "image",
        summary: "generate or edit a raster image (or a fal video)",
        usage:
          'beckett image [video] "<prompt>" [--out <path>] [--size 1024x1024|1536x1024|1024x1536|auto] [--ref <file[,file]>] [--transparent] [--model <codex-model|fal-ai/...|openrouter/...>]',
        run: runImage,
      },
    ],
    busCommands: [],
  };
};

/** The v5 factory-table shape: the {@link asCapability} projection of the extension above. */
export function createImageCapability(deps: CapabilityDeps): Capability {
  return asCapability(createImageExtension(deps));
}
