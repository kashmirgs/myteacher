import React from 'react';
import type { BoardItem, Shape, CoordSystem } from '@myteacher/shared';

type DrawingItem = Extract<BoardItem, { type: "drawing" }>;

interface DrawingCanvasProps {
  item: DrawingItem;
  revealedSteps: number;
}

const SVG_W = 400;
const SVG_H = 300;

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number, yFlipped: boolean): string {
  const startRad = toRad(startDeg);
  const endRad = toRad(endDeg);
  const ySign = yFlipped ? 1 : -1;
  const x1 = cx + r * Math.cos(startRad);
  const y1 = cy + ySign * r * Math.sin(startRad);
  const x2 = cx + r * Math.cos(endRad);
  const y2 = cy + ySign * r * Math.sin(endRad);
  const sweep = endDeg - startDeg;
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 0 ${x2} ${y2} Z`;
}

/**
 * Renders a single shape. When yFlipped=true (coordSystem mode with scale(1,-1)),
 * text elements get a counter-transform so they remain readable.
 * scaleFactor adjusts defaults (strokeWidth, fontSize, point radius) for coordSystem units.
 */
function renderShape(shape: Shape, idx: number, yFlipped: boolean, scaleFactor: number = 1) {
  const key = idx;
  const defStroke = 2 * scaleFactor;
  const defFontSize = 14 * scaleFactor;
  const defPointR = 4 * scaleFactor;
  const defLabelOffset = 10 * scaleFactor;
  const defDash = `${6 * scaleFactor} ${4 * scaleFactor}`;
  switch (shape.type) {
    case "line":
      return (
        <line key={key} x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2}
          stroke={shape.stroke ?? "#e8e8d8"} strokeWidth={shape.strokeWidth ?? defStroke}
          strokeDasharray={shape.dashed ? defDash : undefined}
          className="drawing-line" />
      );
    case "circle":
      return (
        <circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r}
          stroke={shape.stroke ?? "#e8e8d8"} fill={shape.fill ?? "none"}
          strokeWidth={shape.strokeWidth ?? defStroke}
          className="drawing-shape" />
      );
    case "arc":
      return (
        <path key={key} d={arcPath(shape.cx, shape.cy, shape.r, shape.startAngle, shape.endAngle, yFlipped)}
          stroke={shape.stroke ?? "#e8e8d8"} fill={shape.fill ?? "none"}
          strokeWidth={shape.strokeWidth ?? defStroke}
          className="drawing-shape" />
      );
    case "rect":
      return (
        <rect key={key} x={shape.x} y={shape.y} width={shape.width} height={shape.height}
          stroke={shape.stroke ?? "#e8e8d8"} fill={shape.fill ?? "none"}
          strokeWidth={shape.strokeWidth ?? defStroke}
          className="drawing-shape" />
      );
    case "text": {
      const fontSize = shape.fontSize ?? defFontSize;
      const fill = shape.fill ?? "#e8e8d8";
      const anchor = shape.anchor ?? "start";
      if (yFlipped) {
        return (
          <g key={key} transform={`translate(${shape.x}, ${shape.y}) scale(1, -1)`} className="drawing-shape">
            <text x={0} y={0} fontSize={fontSize} fill={fill}
              textAnchor={anchor} dominantBaseline="middle">
              {shape.text}
            </text>
          </g>
        );
      }
      return (
        <text key={key} x={shape.x} y={shape.y}
          fontSize={fontSize} fill={fill}
          textAnchor={anchor} dominantBaseline="middle"
          className="drawing-shape">
          {shape.text}
        </text>
      );
    }
    case "point": {
      const r = shape.r ?? defPointR;
      const label = shape.label;
      let lx = shape.cx, ly = shape.cy;
      const offset = r + defLabelOffset;
      if (label) {
        // In y-flipped mode, "top" means +y in math coords
        switch (shape.labelDir ?? "top") {
          case "top": ly = shape.cy + (yFlipped ? offset : -offset); break;
          case "bottom": ly = shape.cy + (yFlipped ? -offset : offset); break;
          case "left": lx = shape.cx - offset; break;
          case "right": lx = shape.cx + offset; break;
        }
      }
      const labelFontSize = 12 * scaleFactor;
      return (
        <g key={key} className="drawing-shape">
          <circle cx={shape.cx} cy={shape.cy} r={r} fill={shape.fill ?? "#e8e8d8"} />
          {label && (
            yFlipped ? (
              <g transform={`translate(${lx}, ${ly}) scale(1, -1)`}>
                <text x={0} y={0} fontSize={labelFontSize} fill={shape.fill ?? "#e8e8d8"}
                  textAnchor="middle" dominantBaseline="middle">
                  {label}
                </text>
              </g>
            ) : (
              <text x={lx} y={ly} fontSize={labelFontSize} fill={shape.fill ?? "#e8e8d8"}
                textAnchor="middle" dominantBaseline="middle">
                {label}
              </text>
            )
          )}
        </g>
      );
    }
    case "arrow": {
      const markerId = `arrow-${idx}`;
      const stroke = shape.stroke ?? "#e8e8d8";
      const markerSize = 8 * scaleFactor;
      const markerH = 6 * scaleFactor;
      return (
        <g key={key} className="drawing-line">
          <defs>
            <marker id={markerId} markerWidth={markerSize} markerHeight={markerH}
              refX={markerSize} refY={markerH / 2} orient="auto">
              <polygon points={`0 0, ${markerSize} ${markerH / 2}, 0 ${markerH}`} fill={stroke} />
            </marker>
          </defs>
          <line x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2}
            stroke={stroke} strokeWidth={shape.strokeWidth ?? defStroke}
            markerEnd={`url(#${markerId})`} />
        </g>
      );
    }
    case "polygon":
      return (
        <polygon key={key}
          points={shape.points.map(([x, y]: [number, number]) => `${x},${y}`).join(" ")}
          stroke={shape.stroke ?? "#e8e8d8"} fill={shape.fill ?? "none"}
          strokeWidth={shape.strokeWidth ?? defStroke}
          className="drawing-shape" />
      );
    default:
      return null;
  }
}

/** Render coordinate system split into background (grid, axes, tick lines) and foreground (labels) */
function renderCoordSystem(cs: CoordSystem, sf: number): { background: React.ReactElement[]; foreground: React.ReactElement[]; tickLabels: React.ReactElement[] } {
  const background: React.ReactElement[] = [];
  const foreground: React.ReactElement[] = [];
  const tickLabels: React.ReactElement[] = [];
  const showAxes = cs.showAxes !== false;
  const showGrid = cs.showGrid === true;
  const step = cs.gridStep ?? 1;

  if (showGrid) {
    for (let x = Math.ceil(cs.xMin / step) * step; x <= cs.xMax; x += step) {
      background.push(
        <line key={`gx-${x}`} x1={x} y1={cs.yMin} x2={x} y2={cs.yMax}
          stroke="rgba(255,255,255,0.1)" strokeWidth={1 * sf} />
      );
    }
    for (let y = Math.ceil(cs.yMin / step) * step; y <= cs.yMax; y += step) {
      background.push(
        <line key={`gy-${y}`} x1={cs.xMin} y1={y} x2={cs.xMax} y2={y}
          stroke="rgba(255,255,255,0.1)" strokeWidth={1 * sf} />
      );
    }
  }

  if (showAxes) {
    // X axis
    background.push(
      <line key="x-axis" x1={cs.xMin} y1={0} x2={cs.xMax} y2={0}
        stroke="rgba(255,255,255,0.5)" strokeWidth={1.5 * sf} />
    );
    // Y axis
    background.push(
      <line key="y-axis" x1={0} y1={cs.yMin} x2={0} y2={cs.yMax}
        stroke="rgba(255,255,255,0.5)" strokeWidth={1.5 * sf} />
    );

    // Tick marks in background; labels in foreground so circles don't occlude them
    const tickHalf = 5 * sf;
    const tickLabelSize = 11 * sf;
    const tickLabelOffset = 35 * sf;
    for (let x = Math.ceil(cs.xMin / step) * step; x <= cs.xMax; x += step) {
      if (x === 0) continue;
      foreground.push(
        <line key={`tx-${x}`} x1={x} y1={-tickHalf} x2={x} y2={tickHalf} stroke="rgba(255,255,255,0.5)" strokeWidth={1 * sf} />
      );
      tickLabels.push(
        <text key={`txl-${x}`}
          x={x} y={-tickLabelOffset}
          fontSize={tickLabelSize} fill="rgba(255,255,255,0.4)"
          textAnchor="middle" dominantBaseline="auto">{x}</text>
      );
    }
    for (let y = Math.ceil(cs.yMin / step) * step; y <= cs.yMax; y += step) {
      if (y === 0) continue;
      foreground.push(
        <line key={`ty-${y}`} x1={-tickHalf} y1={y} x2={tickHalf} y2={y} stroke="rgba(255,255,255,0.5)" strokeWidth={1 * sf} />
      );
      tickLabels.push(
        <text key={`tyl-${y}`}
          x={-tickLabelOffset} y={-y}
          fontSize={tickLabelSize} fill="rgba(255,255,255,0.4)"
          textAnchor="end" dominantBaseline="middle">{y}</text>
      );
    }

    // Axis labels → foreground
    const axisLabelSize = 13 * sf;
    if (cs.xLabel) {
      tickLabels.push(
        <text key="x-label" x={cs.xMax - 0.3} y={-tickLabelOffset}
          fontSize={axisLabelSize} fill="rgba(255,255,255,0.6)"
          textAnchor="end">{cs.xLabel}</text>
      );
    }
    if (cs.yLabel) {
      tickLabels.push(
        <text key="y-label" x={-tickLabelOffset} y={-(cs.yMax - 0.3)}
          fontSize={axisLabelSize} fill="rgba(255,255,255,0.6)"
          textAnchor="end">{cs.yLabel}</text>
      );
    }
  }

  return { background, foreground, tickLabels };
}

export function DrawingCanvas({ item, revealedSteps }: DrawingCanvasProps) {
  const cs = item.coordSystem;
  const hasCoord = !!cs;

  // Scale factor: maps pixel-based defaults to coordSystem math units
  const scaleFactor = hasCoord
    ? (cs.xMax - cs.xMin + 0.8 * 2) / SVG_W
    : 1;

  // Collect shapes from revealed steps
  let globalShapeIdx = 0;
  const stepGroups: React.ReactElement[] = [];

  for (let si = 0; si < Math.min(revealedSteps, item.steps.length); si++) {
    const step = item.steps[si];
    const isLatest = si === revealedSteps - 1;
    const shapes = step.shapes.map((s, i) => renderShape(s, globalShapeIdx + i, hasCoord, scaleFactor));
    globalShapeIdx += step.shapes.length;
    stepGroups.push(
      <g key={si} className={isLatest ? `drawing-step drawing-step--entering${hasCoord ? ' drawing-step--coord' : ''}` : "drawing-step"}>
        {shapes}
      </g>
    );
  }

  if (hasCoord) {
    const { xMin, xMax, yMin, yMax } = cs;
    const padding = 0.8;
    const vbX = xMin - padding;
    const vbY = -(yMax + padding);
    const vbW = xMax - xMin + padding * 2;
    const vbH = yMax - yMin + padding * 2;
    const coordParts = renderCoordSystem(cs, scaleFactor);

    return (
      <div className="drawing-canvas">
        <svg viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`} preserveAspectRatio="xMidYMid meet">
          <g transform="scale(1, -1)">
            {coordParts.background}
            {stepGroups}
            {coordParts.foreground}
          </g>
          {coordParts.tickLabels}
        </svg>
      </div>
    );
  }

  return (
    <div className="drawing-canvas">
      <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} preserveAspectRatio="xMidYMid meet">
        {stepGroups}
      </svg>
    </div>
  );
}
