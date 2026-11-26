/// <reference types="@webgpu/types" />
import { fixturePixel, present, type Plan, type ShaderPass } from "./compiler";
import { GraphError } from "./graph";

const textureFormat = "rgba16float";
const MEDIA_FORMAT = "rgba8unorm-srgb";
const SHADER_USAGE = () => GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
type Pipeline = { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout };
interface PreparedPass { spec: ShaderPass; program: Pipeline; uniform: GPUBuffer; texture: GPUTexture; group?: GPUBindGroup; inputs?: GPUTexture[] }
export interface PreparedPlan {
  plan: Plan;
  passes: PreparedPass[];
  width: number;
  height: number;
  dispose(): void;
}
export interface Surface { context: GPUCanvasContext }
export interface FrameTime { seconds: number; beats: number }
export type MediaTexture = (asset: string) => GPUTexture | undefined;

export class Renderer {
  readonly format = navigator.gpu.getPreferredCanvasFormat();
  readonly sampler: GPUSampler;
  readonly empty: GPUTexture;
  private readonly pipelines = new Map<string, Promise<Pipeline>>();
  private readonly display: GPURenderPipeline;

  private constructor(readonly device: GPUDevice, readonly adapter: GPUAdapter) {
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.empty = device.createTexture({ size: [1, 1], format: MEDIA_FORMAT, usage: SHADER_USAGE() });
    const shader = device.createShaderModule({ code: present });
    this.display = device.createRenderPipeline({
      layout: "auto", vertex: { module: shader, entryPoint: "vs" },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format: this.format }] },
    });
  }

  static async create() {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter. Open this page in a browser with hardware WebGPU support.");
    const requiredFeatures: GPUFeatureName[] = adapter.features.has("timestamp-query") ? ["timestamp-query"] : [];
    return new Renderer(await adapter.requestDevice({ requiredFeatures }), adapter);
  }

  surface(canvas: HTMLCanvasElement): Surface {
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("Could not configure a WebGPU viewer.");
    context.configure({ device: this.device, format: this.format, alphaMode: "opaque" });
    return { context };
  }

  private pipeline(spec: ShaderPass): Promise<Pipeline> {
    const cached = this.pipelines.get(spec.wgsl);
    if (cached) return cached;
    const pending = (async () => {
      const shader = this.device.createShaderModule({ code: spec.wgsl, label: spec.id });
      const issue = (await shader.getCompilationInfo()).messages.find(message => message.type === "error");
      if (issue) throw new GraphError(issue.message, spec.lines.find(line => issue.lineNum >= line.start && issue.lineNum <= line.end)?.id ?? spec.id);
      const layout = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          ...spec.textures.map((_, index): GPUBindGroupLayoutEntry =>
            ({ binding: index + 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } })),
        ],
      });
      const pipeline = await this.device.createRenderPipelineAsync({
        label: spec.id, layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module: shader, entryPoint: "vs" },
        fragment: { module: shader, entryPoint: "fs", targets: [{ format: textureFormat }] },
      });
      return { pipeline, layout };
    })();
    this.pipelines.set(spec.wgsl, pending);
    pending.catch(() => this.pipelines.delete(spec.wgsl));
    if (this.pipelines.size > 64) this.pipelines.delete(this.pipelines.keys().next().value!);
    return pending;
  }

  async prepare(plan: Plan, width: number, height: number): Promise<PreparedPlan> {
    const programs = await Promise.all(plan.passes.map(pass => this.pipeline(pass)));
    const passes = plan.passes.map((spec, index) => ({
      spec, program: programs[index],
      uniform: this.device.createBuffer({ label: spec.id, size: spec.uniforms.length * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      texture: this.device.createTexture({ label: spec.id, size: [width, height], format: textureFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC }),
    }));
    return { plan, width, height, passes, dispose() {
      for (const pass of passes) { pass.uniform.destroy(); pass.texture.destroy(); }
    } };
  }

  texture(width: number, height: number) {
    return this.device.createTexture({ size: [width, height], format: MEDIA_FORMAT, usage: SHADER_USAGE() });
  }

  fixture(width: number, height: number, seed: number) {
    const texture = this.texture(width, height);
    const bytes = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) bytes.set(fixturePixel(x, y, seed), (y * width + x) * 4);
    }
    this.device.queue.writeTexture({ texture }, bytes, { bytesPerRow: width * 4 }, [width, height]);
    return texture;
  }

  draw(encoder: GPUCommandEncoder, prepared: PreparedPlan, time: FrameTime, media: MediaTexture, timer?: GPUQuerySet) {
    const textures = new Map<string, GPUTexture>();
    for (const [id, asset] of Object.entries(prepared.plan.media)) textures.set(id, media(asset) ?? this.empty);
    for (const [index, pass] of prepared.passes.entries()) {
      const values = new Float32Array(pass.spec.uniforms);
      values.set([time.seconds, time.beats, prepared.width, prepared.height]);
      this.device.queue.writeBuffer(pass.uniform, 0, values);
      const inputs = pass.spec.textures.map(id => textures.get(id)!);
      if (!pass.group || inputs.some((texture, index) => texture !== pass.inputs?.[index])) {
        pass.inputs = inputs;
        pass.group = this.device.createBindGroup({
          layout: pass.program.layout,
          entries: [
            { binding: 0, resource: { buffer: pass.uniform } }, { binding: 1, resource: this.sampler },
            ...inputs.map((texture, index) => ({ binding: index + 2, resource: texture.createView() })),
          ],
        });
      }
      const first = index === 0;
      const last = index === prepared.passes.length - 1;
      const timestamps = timer && (first || last) ? { querySet: timer, beginningOfPassWriteIndex: first ? 0 : undefined,
        endOfPassWriteIndex: last ? 1 : undefined } : undefined;
      this.drawPass(encoder, pass.texture, pass.program.pipeline, pass.group, pass.spec.id, timestamps);
      textures.set(pass.spec.id, pass.texture);
    }
    return textures.get(prepared.plan.root) ?? this.empty;
  }

  show(encoder: GPUCommandEncoder, surface: Surface, texture: GPUTexture) {
    const group = this.device.createBindGroup({
      layout: this.display.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.sampler }, { binding: 1, resource: texture.createView() }],
    });
    this.drawPass(encoder, surface.context.getCurrentTexture(), this.display, group, "Viewer");
  }

  private drawPass(encoder: GPUCommandEncoder, target: GPUTexture, pipeline: GPURenderPipeline, group: GPUBindGroup, label: string,
    timestampWrites?: GPURenderPassTimestampWrites) {
    const pass = encoder.beginRenderPass({
      timestampWrites,
      label, colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
  }
}
