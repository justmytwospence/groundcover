/**
 * MapLibre basemap with a deck.gl layer on its own canvas. See SPEC.md section 6.3.
 *
 * Deliberately NOT deck's MapboxOverlay. In overlaid mode the overlay's canvas never adopted
 * the container's size -- it stayed at the 300x150 HTML default, so every picking coordinate
 * landed outside the viewport and hover never fired. In interleaved mode deck renders inside
 * MapLibre's WebGL context and picking finds nothing at all, even for a plain 4px line layer.
 * A standalone Deck with a canvas we size ourselves, a view state synced from the map, and
 * picking we call ourselves is fully under our control and simply works.
 */

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { Deck } from '@deck.gl/core';
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

/** How far from the cursor to search for a line, in pixels. An 8 m tick is a hairline. */
const PICK_RADIUS = 10;

export interface MapHandles {
  setColors: (colors: Uint8Array, version: number) => void;
  setGeometry: (src: Float32Array, dst: Float32Array, n: number) => void;
  setActivePath: (path: Array<[number, number]> | null) => void;
  getViewport: () => Viewport | null;
  getMapState: () => { c: [number, number]; z: number } | null;
  flyToBounds: (b: [number, number, number, number], durationMs?: number) => void;
  fitIfNeeded: (b: [number, number, number, number]) => void;
  /** Reflect whether something is under the cursor. */
  setHovering: (on: boolean) => void;
}

interface Props {
  onReady: (h: MapHandles) => void;
  onViewportChange: () => void;
  /** Cursor moved over the map: geographic position, a pixel-derived search radius in
   *  metres, and the screen point for tooltip placement. null when the cursor left. */
  onHover: (at: { lng: number; lat: number; radiusM: number; x: number; y: number } | null) => void;
}

export function MapView({ onReady, onViewportChange, onHover }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const deckCanvas = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const deckRef = useRef<Deck | null>(null);
  const geom = useRef<{ src: Float32Array; dst: Float32Array; n: number } | null>(null);
  const colorsRef = useRef<Uint8Array | null>(null);
  const colorVersion = useRef(0);
  const activePath = useRef<Array<[number, number]> | null>(null);
  const mode = useStore((s) => s.mode);

  const rebuild = () => {
    const deck = deckRef.current;
    const g = geom.current;
    if (!deck || !g || !colorsRef.current) return;
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
    deck.setProps({ layers: layers as never });
  };

  useEffect(() => {
    if (!container.current || !deckCanvas.current || mapRef.current) return;
    const el = container.current;
    const saved = readMapFromHash();
    const map = new maplibregl.Map({
      container: el,
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

    const deck = new Deck({
      canvas: deckCanvas.current,
      // MapLibre owns all interaction; deck only mirrors its camera.
      controller: false,
      viewState: {
        longitude: map.getCenter().lng,
        latitude: map.getCenter().lat,
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      },
      layers: [],
    });
    deckRef.current = deck;

    const sync = () => {
      const c = map.getCenter();
      deck.setProps({
        viewState: {
          longitude: c.lng,
          latitude: c.lat,
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
        },
      });
    };
    // 'move' fires continuously through animated flights, so the two stay locked together.
    map.on('move', sync);
    map.on('moveend', onViewportChange);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    // The nearest-site lookup runs in the worker, not through deck's picking: deck's picking
    // pass returns nothing in this setup (see the note at the top of this file), and the
    // worker already holds every site position.
    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const ll = map.unproject([x, y]);
      // Ground metres per CSS pixel at this latitude and zoom.
      const mPerPx =
        (156543.03392 * Math.cos((ll.lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
      onHover({ lng: ll.lng, lat: ll.lat, radiusM: mPerPx * PICK_RADIUS, x, y });
    };
    const onLeave = () => onHover(null);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);

    if (import.meta.env.DEV) {
      // Dev-only handle so a console session can project coordinates and drive picking.
      (window as unknown as Record<string, unknown>).__um = { map, deck };
    }

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
      setHovering: (on) => {
        map.getCanvas().style.cursor = on ? 'pointer' : '';
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
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      deck.finalize();
      deckRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(rebuild, [mode]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={container} style={{ position: 'absolute', inset: 0 }} />
      <canvas
        ref={deckCanvas}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />
    </div>
  );
}
