/** MapLibre basemap with a deck.gl overlay. See SPEC.md section 6.3. */

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { LineLayer, PathLayer } from '@deck.gl/layers';
import 'maplibre-gl/dist/maplibre-gl.css';
import { lngToX, latToY } from '@um/ledger';
import { readMapFromHash, useStore } from '../state/store.js';
import type { Viewport } from '../worker/protocol.js';

const BASEMAP = 'https://tiles.openfreemap.org/styles/dark';

const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#12141a' } }],
};

export interface MapHandles {
  setColors: (colors: Uint8Array, version: number) => void;
  setGeometry: (src: Float32Array, dst: Float32Array, n: number) => void;
  setActivePath: (path: Array<[number, number]> | null) => void;
  getViewport: () => Viewport | null;
  getMapState: () => { c: [number, number]; z: number } | null;
  flyToBounds: (b: [number, number, number, number], durationMs?: number) => void;
  /** Fit only when the target is not already comfortably framed, so following a selection
   *  does not produce constant micro-adjustments while scrubbing or playing back. */
  fitIfNeeded: (b: [number, number, number, number]) => void;
}

interface Props {
  onReady: (h: MapHandles) => void;
  onViewportChange: () => void;
  onHover: (siteIndex: number | null, x: number, y: number) => void;
}

export function MapView({ onReady, onViewportChange, onHover }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const geom = useRef<{ src: Float32Array; dst: Float32Array; n: number } | null>(null);
  const colorsRef = useRef<Uint8Array | null>(null);
  const colorVersion = useRef(0);
  const activePath = useRef<Array<[number, number]> | null>(null);
  const mode = useStore((s) => s.mode);

  // Rebuild layers from whatever is currently in the refs.
  const rebuild = () => {
    const overlay = overlayRef.current;
    const g = geom.current;
    if (!overlay || !g || !colorsRef.current) return;
    const heat = useStore.getState().mode === 'heatmap';
    const coverage = new LineLayer({
      id: 'coverage',
      data: {
        length: g.n,
        attributes: {
          getSourcePosition: { value: g.src, size: 2 },
          getTargetPosition: { value: g.dst, size: 2 },
          getColor: { value: colorsRef.current, size: 4, normalized: true },
        },
      },
      widthUnits: 'meters',
      getWidth: 7,
      widthMinPixels: 1.2,
      widthMaxPixels: 8,
      pickable: true,
      // Additive blending in heatmap mode so overlapping density accumulates into a glow.
      parameters: heat
        ? ({
            blend: true,
            blendColorSrcFactor: 'src-alpha',
            blendColorDstFactor: 'one',
            blendColorOperation: 'add',
          } as const)
        : {},
      updateTriggers: { getColor: colorVersion.current },
      onHover: (info) => onHover(info.index >= 0 ? info.index : null, info.x, info.y),
    });

    const layers: unknown[] = [coverage];
    if (activePath.current && activePath.current.length > 1) {
      layers.push(
        new PathLayer({
          id: 'active',
          data: [{ path: activePath.current }],
          getPath: (d: { path: Array<[number, number]> }) => d.path,
          getColor: [255, 255, 245, 235],
          widthUnits: 'meters',
          getWidth: 12,
          widthMinPixels: 2.5,
          capRounded: true,
          jointRounded: true,
        }),
      );
    }
    overlay.setProps({ layers: layers as never });
  };

  useEffect(() => {
    if (!container.current || mapRef.current) return;
    const saved = readMapFromHash();
    const map = new maplibregl.Map({
      container: container.current,
      style: BASEMAP,
      center: saved?.center ?? [-98, 39],
      zoom: saved?.zoom ?? 3,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on('error', (e) => {
      // A missing basemap must not take the coverage layer down with it.
      if (String(e?.error?.message ?? '').includes('style')) map.setStyle(FALLBACK_STYLE);
    });

    const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    overlayRef.current = overlay;
    map.addControl(overlay as unknown as maplibregl.IControl);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    map.on('moveend', onViewportChange);

    const handles: MapHandles = {
      setColors: (colors, version) => {
        colorsRef.current = colors;
        colorVersion.current = version;
        rebuild();
      },
      setGeometry: (src, dst, n) => {
        geom.current = { src, dst, n };
        rebuild();
      },
      setActivePath: (p) => {
        activePath.current = p;
        rebuild();
      },
      getViewport: () => {
        const b = map.getBounds();
        // Mercator centimetres, the space sites.bin already stores. getBounds() returns the
        // bounding box of the visible region, so this stays correct when the map is rotated.
        return {
          minX: lngToX(b.getWest()) * 100,
          maxX: lngToX(b.getEast()) * 100,
          minY: latToY(b.getSouth()) * 100,
          maxY: latToY(b.getNorth()) * 100,
        };
      },
      getMapState: () => {
        const c = map.getCenter();
        return { c: [c.lng, c.lat], z: map.getZoom() };
      },
      flyToBounds: (bb, durationMs = 900) => {
        map.fitBounds(
          [
            [bb[0], bb[1]],
            [bb[2], bb[3]],
          ],
          { padding: 80, duration: durationMs },
        );
      },
      fitIfNeeded: (bb) => {
        const cur = map.getBounds();
        const contained =
          bb[0] >= cur.getWest() && bb[2] <= cur.getEast() && bb[1] >= cur.getSouth() && bb[3] <= cur.getNorth();
        const curW = cur.getEast() - cur.getWest();
        const curH = cur.getNorth() - cur.getSouth();
        // Already framed AND filling a reasonable share of the view: leave it alone.
        const fillsView = (bb[2] - bb[0]) / (curW || 1) > 0.3 && (bb[3] - bb[1]) / (curH || 1) > 0.3;
        if (contained && fillsView) return;
        map.fitBounds(
          [
            [bb[0], bb[1]],
            [bb[2], bb[3]],
          ],
          { padding: 80, duration: 700 },
        );
      },
    };

    map.once('load', () => onReady(handles));
    // Hand over handles even if the basemap never loads.
    const t = window.setTimeout(() => onReady(handles), 4000);
    return () => {
      window.clearTimeout(t);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(rebuild, [mode]);

  return <div ref={container} style={{ position: 'absolute', inset: 0 }} />;
}
