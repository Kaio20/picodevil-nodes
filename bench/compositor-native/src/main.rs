use serde::Deserialize;
use std::collections::HashMap;
use std::error::Error;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use wgpu::util::DeviceExt;

const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;

#[derive(Deserialize)]
struct Fixture {
    media: HashMap<String, String>,
    passes: Vec<Pass>,
}

#[derive(Deserialize)]
struct Pass {
    id: String,
    textures: Vec<String>,
    uniforms: Vec<f32>,
    wgsl: String,
}

struct Prepared {
    pipeline: wgpu::RenderPipeline,
    group: wgpu::BindGroup,
    uniforms: Vec<f32>,
    buffer: wgpu::Buffer,
    target: wgpu::TextureView,
}

fn texture(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
    usage: wgpu::TextureUsages,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}

fn encode_uniforms(values: &[f32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn input_texture(device: &wgpu::Device, queue: &wgpu::Queue, seed: u32) -> wgpu::TextureView {
    let image = texture(
        device,
        wgpu::TextureFormat::Rgba8UnormSrgb,
        wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
    );
    let bytes: Vec<_> = (0..HEIGHT)
        .flat_map(|y| {
            (0..WIDTH).flat_map(move |x| {
                [
                    (x + seed * 53) as u8,
                    (y + seed * 87) as u8,
                    ((x ^ y) + seed * 17) as u8,
                    255,
                ]
            })
        })
        .collect();
    queue.write_texture(
        image.as_image_copy(),
        &bytes,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(WIDTH * 4),
            rows_per_image: Some(HEIGHT),
        },
        image.size(),
    );
    image.create_view(&Default::default())
}

fn prepare(device: &wgpu::Device, queue: &wgpu::Queue, fixture: Fixture) -> Vec<Prepared> {
    let mut textures: HashMap<_, _> = fixture
        .media
        .iter()
        .map(|(id, asset)| {
            let seed = if asset == "demo-a" { 1 } else { 2 };
            (id.clone(), input_texture(device, queue, seed))
        })
        .collect();
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });
    let fragment_only = wgpu::ShaderStages::FRAGMENT;
    let make_layout = |binding, ty| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: fragment_only,
        ty,
        count: None,
    };
    fixture
        .passes
        .into_iter()
        .map(|pass| {
            let formats = [Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba16Float,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })];
            let mut entries = vec![
                make_layout(
                    0,
                    wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                ),
                make_layout(
                    1,
                    wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                ),
            ];
            entries.extend(pass.textures.iter().enumerate().map(|(index, _)| {
                make_layout(
                    index as u32 + 2,
                    wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                )
            }));
            let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some(&pass.id),
                entries: &entries,
            });
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None,
                bind_group_layouts: &[&layout],
                push_constant_ranges: &[],
            });
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(&pass.id),
                source: wgpu::ShaderSource::Wgsl(pass.wgsl.into()),
            });
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(&pass.id),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs"),
                    targets: &formats,
                    compilation_options: Default::default(),
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview: None,
                cache: None,
            });
            let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: &encode_uniforms(&pass.uniforms),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
            let mut resources = vec![
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ];
            resources.extend(pass.textures.iter().enumerate().map(|(index, id)| {
                wgpu::BindGroupEntry {
                    binding: index as u32 + 2,
                    resource: wgpu::BindingResource::TextureView(&textures[id]),
                }
            }));
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &layout,
                entries: &resources,
            });
            let image = texture(
                device,
                wgpu::TextureFormat::Rgba16Float,
                wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
            );
            let target = image.create_view(&Default::default());
            textures.insert(pass.id, target.clone());
            Prepared {
                pipeline,
                group,
                uniforms: pass.uniforms,
                buffer,
                target,
            }
        })
        .collect()
}

struct Timer {
    query: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    read: wgpu::Buffer,
}

impl Timer {
    fn new(device: &wgpu::Device) -> Self {
        Self {
            query: device.create_query_set(&wgpu::QuerySetDescriptor {
                label: None,
                ty: wgpu::QueryType::Timestamp,
                count: 2,
            }),
            resolve: device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: 16,
                usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
            read: device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: 16,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            }),
        }
    }
}

fn frame(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    prepared: &mut [Prepared],
    timer: Option<&Timer>,
    time: f32,
) -> Result<(f64, Option<f64>), Box<dyn Error>> {
    let start = Instant::now();
    let count = prepared.len();
    let mut encoder = device.create_command_encoder(&Default::default());
    for (index, pass) in prepared.iter_mut().enumerate() {
        pass.uniforms[..4].copy_from_slice(&[time, time * 2.0, WIDTH as f32, HEIGHT as f32]);
        queue.write_buffer(&pass.buffer, 0, &encode_uniforms(&pass.uniforms));
        let timestamps = timer
            .filter(|_| index == 0 || index + 1 == count)
            .map(|timer| wgpu::RenderPassTimestampWrites {
                query_set: &timer.query,
                beginning_of_pass_write_index: (index == 0).then_some(0),
                end_of_pass_write_index: (index + 1 == count).then_some(1),
            });
        let mut render = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &pass.target,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: timestamps,
            occlusion_query_set: None,
        });
        render.set_pipeline(&pass.pipeline);
        render.set_bind_group(0, &pass.group, &[]);
        render.draw(0..3, 0..1);
    }
    if let Some(timer) = timer {
        encoder.resolve_query_set(&timer.query, 0..2, &timer.resolve, 0);
        encoder.copy_buffer_to_buffer(&timer.resolve, 0, &timer.read, 0, 16);
    }
    queue.submit([encoder.finish()]);
    let gpu = if let Some(timer) = timer {
        let (send, receive) = mpsc::channel();
        timer
            .read
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = send.send(result);
            });
        device
            .poll(wgpu::PollType::Wait)
            .map_err(|error| format!("GPU poll failed: {error:?}"))?;
        receive.recv()??;
        let bytes = timer.read.slice(..).get_mapped_range();
        let start = u64::from_le_bytes(bytes[..8].try_into()?);
        let end = u64::from_le_bytes(bytes[8..].try_into()?);
        let duration =
            end.saturating_sub(start) as f64 * f64::from(queue.get_timestamp_period()) / 1e6;
        drop(bytes);
        timer.read.unmap();
        Some(duration)
    } else {
        device
            .poll(wgpu::PollType::Wait)
            .map_err(|error| format!("GPU poll failed: {error:?}"))?;
        None
    };
    Ok((start.elapsed().as_secs_f64() * 1000., gpu))
}

fn stats(mut values: Vec<f64>) -> serde_json::Value {
    values.sort_by(f64::total_cmp);
    if values.is_empty() {
        return serde_json::Value::Null;
    }
    serde_json::json!({"n": values.len(), "p50": values[values.len() / 2], "p95": values[(values.len() * 95 / 100).min(values.len() - 1)]})
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let file = args
        .next()
        .ok_or("Usage: compositor-native <plan.json> [seconds=30] [runs=3]")?;
    let seconds: u64 = args.next().map(|s| s.parse()).transpose()?.unwrap_or(30);
    let runs: u32 = args.next().map(|s| s.parse()).transpose()?.unwrap_or(3);
    if seconds == 0 || runs == 0 {
        return Err("Seconds and runs must be positive.".into());
    }
    let fixture: Fixture = serde_json::from_slice(&std::fs::read(file)?)?;
    if fixture.passes.is_empty() {
        return Err("The fixture has no GPU passes.".into());
    }
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::DX12,
        ..Default::default()
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))?;
    let info = adapter.get_info();
    let features = adapter.features() & wgpu::Features::TIMESTAMP_QUERY;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: None,
        required_features: features,
        ..Default::default()
    }))?;
    let timer = features
        .contains(wgpu::Features::TIMESTAMP_QUERY)
        .then(|| Timer::new(&device));
    let mut prepared = prepare(&device, &queue, fixture);
    let warmup = Instant::now();
    while warmup.elapsed() < Duration::from_secs(2) {
        frame(
            &device,
            &queue,
            &mut prepared,
            timer.as_ref(),
            warmup.elapsed().as_secs_f32(),
        )?;
    }
    let mut reports = Vec::new();
    for _ in 0..runs {
        let anchor = Instant::now();
        let mut wall = Vec::new();
        let mut gpu = Vec::new();
        for index in 0..seconds * 60 {
            let scheduled = Duration::from_secs_f64(index as f64 / 60.);
            if let Some(delay) = scheduled.checked_sub(anchor.elapsed()) {
                std::thread::sleep(delay);
            }
            let (elapsed, timestamp) = frame(
                &device,
                &queue,
                &mut prepared,
                timer.as_ref(),
                index as f32 / 60.,
            )?;
            wall.push(elapsed);
            if let Some(ms) = timestamp {
                gpu.push(ms);
            }
        }
        reports.push(serde_json::json!({"submitAndWaitMs": stats(wall), "gpuMs": stats(gpu)}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "adapter": info.name, "vendor": format!("{:04x}", info.vendor), "device": format!("{:04x}", info.device),
            "backend": format!("{:?}", info.backend), "passes": prepared.len(),
            "width": WIDTH, "height": HEIGHT, "runs": reports,
        }))?
    );
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    run()
}
