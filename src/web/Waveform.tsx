import { useEffect, useEffectEvent, useRef } from "react";

/** Time in milliseconds between 2 bars. */
const BAR_INTERVAL = 60;
/** The width of a bar and the distance to the next bar, in CSS pixels. */
const BAR_WIDTH = 2;
const BAR_STEP = 4;
const MIN_BAR_HEIGHT = 2;
/** The height of the tallest bar, as a part of the canvas height. */
const MAX_BAR = 0.7;
/** The level range of the bars in dB of full scale. Quiet noise is at the bottom, and normal speech gives tall bars. */
const MIN_DB = -60;
const MAX_DB = -10;

type WaveformProps = {
  analyser: AnalyserNode;
  /** The name of the microphone. */
  label: string;
  /** Called on each frame with a sample that is not exactly 0. A microphone with digital silence never calls it. */
  onSound: () => void;
};

/** The live level of a recording: bars that move from right to left. Silence shows a flat row of short bars. */
export function Waveform({ analyser, label, onSound }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sound = useEffectEvent(onSound);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const context = canvas.getContext("2d")!;
    const color = getComputedStyle(canvas).color;
    const samples = new Float32Array(analyser.fftSize);
    /** The levels of the bars from 0 to 1, the newest last. */
    const levels: number[] = [];
    /** The loudest frame since the last bar, as the root mean square of its samples. */
    let peak = 0;
    /** The time of the last bar. At 0, the first frame draws a bar at once. */
    let last = 0;
    let frame = requestAnimationFrame(draw);

    function draw(now: number) {
      frame = requestAnimationFrame(draw);
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      // The sum is 0 only when every sample is exactly 0.
      if (sum > 0) sound();
      peak = Math.max(peak, Math.sqrt(sum / samples.length));
      if (now - last < BAR_INTERVAL) return;
      last = now;
      levels.push(Math.min(Math.max((20 * Math.log10(peak) - MIN_DB) / (MAX_DB - MIN_DB), 0), 1));
      peak = 0;

      // The canvas has a pixel for each screen pixel, so the bars are sharp.
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const ratio = devicePixelRatio;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      // The newest bar is at the right edge. Bars without a level yet have the minimum height.
      const count = Math.ceil(width / BAR_STEP);
      levels.splice(0, levels.length - count);
      context.beginPath();
      for (let index = 0; index < count; index++) {
        const x = width - BAR_WIDTH - index * BAR_STEP;
        const barHeight = Math.max(MIN_BAR_HEIGHT, (levels[levels.length - 1 - index] ?? 0) * height * MAX_BAR);
        context.roundRect(x, (height - barHeight) / 2, BAR_WIDTH, barHeight, BAR_WIDTH / 2);
      }
      context.fillStyle = color;
      context.fill();
    }

    return () => cancelAnimationFrame(frame);
  }, [analyser]);

  return <canvas ref={canvasRef} className="waveform" title={`Recording from ${label}`} />;
}
