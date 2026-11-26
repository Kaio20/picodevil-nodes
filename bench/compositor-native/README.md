# Compositor GPU comparison

Run the dev server first. The browser runner uses installed Google Chrome with hardware WebGPU and measures at 1920 × 1080, with 60 Hz as the target. It runs the classic editor with the two bundled 1080p clips, then the compositor with those clips and the selected Noise preview off and on. Each mode warms up and defaults to three 30-second samples. The legacy graph uses its own Modulate, Matte and Blend; both editor runs represent a two-clip compositing workload.

```powershell
$compositorFixture = Join-Path $env:TEMP 'nodesdevil-compositor-fixture.json'
npm.cmd run bench:compositor -- "--fixture=$compositorFixture"
cargo run --release --locked --manifest-path bench/compositor-native/Cargo.toml -- "$compositorFixture" 30 3
```

Run the commands consecutively. `--only=legacy`, `--only=compositor` and `--only=gpu` select one browser leg. `--only=fixture` writes the plan without launching Chrome. `--seconds=2 --runs=1` is a short smoke run. Use `--url=http://localhost:5174` if Vite picked a different port.

The offscreen browser leg and the native Direct3D 12 runner use the same compiled WGSL render passes, 1080p textures generated from the same pixel formula, and frame inputs sampled at 60 Hz. Both report GPU timestamps when supported and wall-clock time from encode through completion. Verify the adapters match before comparing the GPU results.

The editor legs include video playback and the output window. Browser decode latency comes from video-frame callback metadata. CPU upload time measures dispatch, and queue completion includes scheduled GPU work. Misses are estimated from output frame intervals or skipped submissions, so the figure is a render-loop metric. The offscreen GPU leg excludes video decoding and window presentation.

## Windows test result

Three 30-second runs per mode on an NVIDIA GeForce RTX 4080 SUPER with Chrome 158.0.8127.88. Ranges show variation across the three runs.

| Editor at 1080p / 60 Hz | p95 CPU work | p95 queue completion | Estimated missed frames |
| --- | ---: | ---: | ---: |
| Classic with a node preview | 0.9–1.1 ms | — | 0% |
| Compositor, preview off | 0.4 ms | 9.9–10.7 ms | 0.17–0.39% |
| Compositor, Noise preview on | 0.4–0.5 ms | 8.1–10.0 ms | 0.06–0.22% |

The classic work counter ends before its preview render. Both compositor modes reported 0.3 ms p95 CPU upload dispatch and 283.5 ms p95 video-frame processing duration from Chrome's decoder metadata. The decoder value is a separate measurement from the output-frame budget.

| Offscreen GPU path | p95 shader-pass time | p95 submit and wait |
| --- | ---: | ---: |
| Chrome WebGPU | 0.60–1.50 ms | 4.5–5.1 ms |
| Rust / Direct3D 12 | 0.43–1.16 ms | 3.89–4.28 ms |

The browser compositor stayed within the 16.7 ms frame-work budget and the 1% miss target in every run. GPU times were well within budget on both backends. These results support using the browser for this two-clip patch. Larger graphs and other media sources need their own measurements.
