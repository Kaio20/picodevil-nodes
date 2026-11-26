const quiet = [0, 0, 0, 0];

export class AudioInput {
  private input?: { context: AudioContext; stream: MediaStream; analyser: AnalyserNode; spectrum: Uint8Array<ArrayBuffer>; waveform: Float32Array<ArrayBuffer> };

  get active() { return Boolean(this.input); }

  async start(onEnded: () => void) {
    const context = new AudioContext();
    let stream: MediaStream | undefined;
    try {
      await context.resume();
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      this.input = { context, stream, analyser,
        spectrum: new Uint8Array(analyser.frequencyBinCount), waveform: new Float32Array(analyser.fftSize) };
      for (const track of stream.getAudioTracks()) track.addEventListener("ended", () => { this.stop(); onEnded(); });
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      await context.close();
      throw error;
    }
  }

  stop() {
    const input = this.input;
    this.input = undefined;
    if (input) {
      input.stream.getTracks().forEach(track => track.stop());
      void input.context.close();
    }
  }

  values() {
    if (!this.input) return quiet;
    const { analyser, spectrum, waveform, context } = this.input;
    analyser.getByteFrequencyData(spectrum);
    analyser.getFloatTimeDomainData(waveform);
    let power = 0;
    for (const sample of waveform) power += sample ** 2;
    const hzPerBin = context.sampleRate / analyser.fftSize;
    const bands = [[40, 250], [250, 2000], [2000, 10000]].map(([low, high]) => {
      const start = Math.min(spectrum.length - 1, Math.ceil(low / hzPerBin));
      const end = Math.min(spectrum.length, Math.max(start + 1, Math.ceil(high / hzPerBin)));
      let sum = 0;
      for (let bin = start; bin < end; bin++) sum += spectrum[bin];
      return sum / (255 * (end - start));
    });
    return [Math.sqrt(power / waveform.length), ...bands];
  }
}
