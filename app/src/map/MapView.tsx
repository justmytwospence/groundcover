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
import { readInitialView, useStore } from '../state/store.js';
import { BASEMAP_STYLES, TERRAIN_TILES, type Theme } from '../lib/theme.js';
import type { Viewport } from '../worker/protocol.js';

const fallbackStyle = (theme: Theme): maplibregl.StyleSpecification => ({
  version: 8,
  sources: {},
  layers: [
    {
      id: 'bg',
      type: 'background',
      paint: { 'background-color': theme === 'light' ? '#f4f4f1' : '#1b1f27' },
    },
  ],
});

/**
 * How hard to chase a basemap before moving to the next provider, and then to a flat background.
 *
 * Two distinct failures have to be caught, because only one of them announces itself:
 *
 *  - the style request fails outright (the host answers an occasional 503), which raises an
 *    error carrying the URL, and
 *  - the style loads, its sources are present, and no tile is ever fetched. Nothing is raised;
 *    the map simply stays empty. Only a watchdog finds this one, and it is the failure that
 *    was leaving the published map a flat field with routes floating on it.
 */
const STYLE_RETRIES = 1;
const STYLE_RETRY_MS = 600;
/**
 * How long a style gets to load a source before it is treated as dead. Generous: this is the
 * style document, its sprites and its first tiles over someone's phone connection, and a false
 * positive costs a visible reload of the basemap.
 */
const STYLE_WATCHDOG_MS = 12_000;

/**
 * Padding every automatic fit leaves around what it frames, in pixels.
 *
 * 80 when the panels floated over the map, and even that was three to seven times short of the
 * 222-302 px the rail actually covered. Now that nothing persistent sits on top of the map
 * (theme.css, "The shell"), this is breathing room and nothing else.
 */
const FIT_PAD = 32;

/**
 * How far from the cursor to search for a line, in pixels. An 8 m tick is a hairline.
 *
 * A fingertip covers far more than a mouse cursor points at, and on a phone there is no hover
 * pass to correct a miss with -- the first tap either lands or reads as a dead map.
 */
const PICK_RADIUS = 10;
const PICK_RADIUS_COARSE = 22;
const pickRadius = () =>
  window.matchMedia?.('(pointer: coarse)').matches ? PICK_RADIUS_COARSE : PICK_RADIUS;

/**
 * Every camera move the app makes itself, rather than in response to a drag or a wheel.
 *
 * `essential: true` is the point of this helper. Without it MapLibre honours the OS
 * `prefers-reduced-motion` setting by discarding `duration` entirely, so a refit becomes an
 * instant jump-cut -- the map teleports and the viewer loses track of where they were. Framing
 * a route the viewer did not ask to be framed is exactly the move that needs to be readable, so
 * it is declared essential and animated on every machine. The durations stay short (400 to
 * 900 ms), which is the actual concession to reduced motion.
 */
function easeToBounds(
  map: maplibregl.Map,
  bb: [maplibregl.LngLatLike, maplibregl.LngLatLike],
  opts: { padding: number; duration: number },
) {
  map.fitBounds(bb, { ...opts, essential: true });
}

export interface MapHandles {
  setColors: (colors: Uint8Array, version: number) => void;
  setGeometry: (src: Float32Array, dst: Float32Array, n: number) => void;
  setActivePath: (path: Array<[number, number]> | null) => void;
  getViewport: () => Viewport | null;
  /** The visible extent as [west, south, east, north] degrees. */
  getBounds: () => [number, number, number, number] | null;
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
  /** Map clicked. Uses MapLibre's click event, which already distinguishes a click from the
   *  end of a drag. */
  onPick: (at: { lng: number; lat: number; radiusM: number; x: number; y: number }) => void;
}

export function MapView({ onReady, onViewportChange, onHover, onPick }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const deckCanvas = useRef<HTMLCanvasElement>(null);
  const boxEl = useRef<HTMLDivElement>(null);
  /** True while a modifier-drag zoom box is being dragged. */
  const boxing = useRef(false);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const deckRef = useRef<Deck | null>(null);
  const geom = useRef<{ src: Float32Array; dst: Float32Array; n: number } | null>(null);
  /**
   * The extent the app last asked to be framed, held until the viewer moves the map themselves.
   *
   * A fit is computed against the container's size at that instant, and `map.resize()` keeps the
   * centre and zoom rather than the extent -- so any layout change silently rescopes the framing.
   * That bites hardest on the very first fit, which lands before the grid has sized the map's
   * cell: the framed box ended up several zoom levels out, with the routes as specks.
   */
  const framed = useRef<[number, number, number, number] | null>(null);
  /** Which entry of BASEMAP_STYLES is currently serving. Survives a theme change and a remount. */
  const styleIndex = useRef(0);
  const colorsRef = useRef<Uint8Array | null>(null);
  const colorVersion = useRef(0);
  const activePath = useRef<Array<[number, number]> | null>(null);
  const mode = useStore((s) => s.mode);
  const theme = useStore((s) => s.theme);
  const hillshade = useStore((s) => s.hillshade);

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
    const saved = readInitialView();
    const map = new maplibregl.Map({
      container: el,
      style: BASEMAP_STYLES[useStore.getState().theme][styleIndex.current],
      // An extent is framed by the constructor, which has the container size in hand; a centre
      // and zoom are set directly. Either way the map opens already there, with no flight in
      // from the default view.
      ...(saved?.kind === 'bounds'
        ? { bounds: saved.bounds, fitBoundsOptions: { padding: FIT_PAD } }
        : { center: saved?.center ?? [-98, 39], zoom: saved?.zoom ?? 3 }),
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    if (saved?.kind === 'bounds') framed.current = saved.bounds;
    if (import.meta.env.DEV) {
      // Dev-only handle, matching __umStore in state/store.ts: the basemap is loaded from a
      // third-party host and its failures are only diagnosable from a console.
      (window as unknown as Record<string, unknown>).__umMap = map;
    }

    // Two fingers on a phone rotate and pitch by default. `getViewport` honours a rotated map,
    // so an accidental twist silently widens the viewport filter and moves the numbers in the
    // stats panel -- a change nobody asked for and nobody can see the cause of. Zoom is the
    // only two-finger gesture this map has any use for.
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    map.touchPitch.disable();

    // A missing basemap must not take the coverage layer down with it, and a flat grey field is
    // the last resort rather than the first response. Walk the providers, giving each one a
    // retry, and only then give up. See BASEMAP_STYLES in lib/theme.ts.
    //
    // Failures are matched on the failed request's URL, never on the error text. A substring
    // test for "style" also caught the relief layer's tile errors -- which is how switching
    // Terrain on blanked the basemap -- and MapLibre's own "Style is not done loading", which
    // this handler's setStyle provokes: error, retry, error, forever.
    let styleTries = 0;
    let watchdog: number | undefined;

    const styleList = () => BASEMAP_STYLES[useStore.getState().theme];

    /** Move to the next provider, or to the blank background once they are all spent. */
    const nextProvider = (reason: string) => {
      window.clearTimeout(watchdog);
      const list = styleList();
      const next = styleIndex.current + 1;
      if (import.meta.env.DEV) console.warn(`[um] basemap ${reason}; trying provider ${next}`);
      if (next >= list.length) {
        map.setStyle(fallbackStyle(useStore.getState().theme));
        return;
      }
      styleIndex.current = next;
      styleTries = 0;
      applyStyle();
    };

    /**
     * Has any of this style's own sources finished loading? The health check for a provider,
     * and deliberately NOT `isStyleLoaded()`: that also reads false whenever the browser has
     * simply not painted yet -- a background tab, an occluded window -- because MapLibre loads
     * tiles from its render loop and a throttled `requestAnimationFrame` means no render. A
     * watchdog on that would cycle away from a perfectly good provider for a viewer who had
     * merely switched tabs.
     */
    let sourceLoaded = false;

    const armWatchdog = () => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        if (sourceLoaded) return;
        // Nothing has painted yet, so nothing has been asked of the provider and it has not
        // failed anything. Wait for the tab to come back rather than blaming it.
        if (document.visibilityState !== 'visible') return;
        nextProvider('loaded no sources');
      }, STYLE_WATCHDOG_MS);
    };

    /** Set the current provider's style and start the clock on it. */
    const applyStyle = () => {
      const url = styleList()[styleIndex.current];
      if (!url) return;
      sourceLoaded = false;
      map.setStyle(url);
      armWatchdog();
    };

    map.on('sourcedata', (e) => {
      // The relief layer is an extra, not the basemap: it must not vouch for a provider.
      if (!e.isSourceLoaded || e.sourceId === 'um-dem') return;
      sourceLoaded = true;
      window.clearTimeout(watchdog);
    });

    // A tab that comes back to the foreground gets its render loop, and therefore its first
    // real chance to load a tile, so the clock starts then rather than having run down unseen.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !sourceLoaded) armWatchdog();
    };
    document.addEventListener('visibilitychange', onVisible);

    map.on('error', (e) => {
      const url = (e.error as { url?: string } | undefined)?.url ?? '';
      if (url !== styleList()[styleIndex.current]) return;
      if (styleTries < STYLE_RETRIES) {
        styleTries += 1;
        window.setTimeout(applyStyle, STYLE_RETRY_MS * styleTries);
        return;
      }
      nextProvider('failed to load');
    });

    // Arrived: let the next failure spend its own budget rather than inherit what this one used.
    map.on('styledata', () => {
      if (map.isStyleLoaded()) styleTries = 0;
    });

    // The constructor started the first provider loading, so it needs the same clock.
    armWatchdog();

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
    // Only a gesture carries an originalEvent; the app's own eases do not. Once the viewer has
    // moved the map, where they put it outranks whatever the app last framed.
    map.on('movestart', (e) => {
      if ((e as { originalEvent?: unknown }).originalEvent) framed.current = null;
    });

    // The map is a grid cell now, not the window, so it changes size without the window doing
    // anything: the sheet drags, the charts widen the rail, a scrollbar appears. MapLibre only
    // watches the window, and the deck canvas is sized by CSS alone, so without this the
    // projection and every picked coordinate quietly refer to the old size.
    const ro = new ResizeObserver(() => {
      map.resize();
      // Re-frame rather than merely re-project, so the promise a fit made survives the sheet
      // being dragged, the charts widening the rail, or the first layout arriving late.
      const bb = framed.current;
      if (bb) {
        map.fitBounds(
          [
            [bb[0], bb[1]],
            [bb[2], bb[3]],
          ],
          { padding: FIT_PAD, duration: 0, essential: true },
        );
      }
      sync();
    });
    ro.observe(el);
    map.on('moveend', onViewportChange);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    // The nearest-site lookup runs in the worker, not through deck's picking: deck's picking
    // pass returns nothing in this setup (see the note at the top of this file), and the
    // worker already holds every site position.
    const onMove = (e: PointerEvent) => {
      if (boxing.current) return;
      // A finger has no hover. `pointerleave` is unreliable for touch, so a tooltip opened this
      // way would sit under the finger until something else dismissed it -- and a tap already
      // opens the fuller SitePopup through the click handler below.
      if (e.pointerType === 'touch') return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const ll = map.unproject([x, y]);
      // Ground metres per CSS pixel at this latitude and zoom.
      const mPerPx =
        (156543.03392 * Math.cos((ll.lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
      onHover({ lng: ll.lng, lat: ll.lat, radiusM: mPerPx * pickRadius(), x, y });
    };
    const onLeave = () => onHover(null);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);

    // ---- modifier-drag zoom box ----------------------------------------------------------
    //
    // MapLibre already box-zooms on shift+drag, but shift is not a modifier anyone guesses, and
    // it draws nothing while you drag. This adds Cmd (or Ctrl) with a visible rectangle, and
    // leaves the built-in shift behaviour alone.
    let boxStart: { x: number; y: number } | null = null;
    // Disabling dragPan for the box means MapLibre never sees a drag, so it reports the
    // gesture as an ordinary click and pins a site popup on whatever the box happened to
    // start over. The click arrives right after pointerup, so one flag is enough.
    let swallowNextClick = false;

    const paintBox = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const box = boxEl.current;
      if (!box) return;
      box.style.display = 'block';
      box.style.left = `${Math.min(a.x, b.x)}px`;
      box.style.top = `${Math.min(a.y, b.y)}px`;
      box.style.width = `${Math.abs(a.x - b.x)}px`;
      box.style.height = `${Math.abs(a.y - b.y)}px`;
    };

    const endBox = () => {
      boxStart = null;
      boxing.current = false;
      if (boxEl.current) boxEl.current.style.display = 'none';
      map.dragPan.enable();
    };

    const onBoxDown = (e: PointerEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      boxStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      boxing.current = true;
      // Otherwise the map pans underneath the rectangle being drawn.
      map.dragPan.disable();
      onHover(null);
      e.preventDefault();
    };

    const onBoxMove = (e: PointerEvent) => {
      if (!boxStart) return;
      const rect = el.getBoundingClientRect();
      paintBox(boxStart, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    };

    const onBoxUp = (e: PointerEvent) => {
      if (!boxStart) return;
      const rect = el.getBoundingClientRect();
      const end = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const start = boxStart;
      const dragged = Math.abs(start.x - end.x) > 8 && Math.abs(start.y - end.y) > 8;
      endBox();
      // A stray modifier-click is not a zoom request. Anything smaller than this would also
      // zoom to a degenerate box and leave the user somewhere they did not ask to be.
      if (!dragged) return;
      swallowNextClick = true;
      easeToBounds(map, [map.unproject([start.x, start.y]), map.unproject([end.x, end.y])], {
        padding: 24,
        duration: 400,
      });
    };

    const onBoxKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && boxStart) endBox();
    };
    // Ctrl+drag is a right-click gesture on macOS; without this the menu interrupts the drag.
    const onCtxMenu = (e: Event) => {
      if (boxing.current) e.preventDefault();
    };

    el.addEventListener('pointerdown', onBoxDown);
    window.addEventListener('pointermove', onBoxMove);
    window.addEventListener('pointerup', onBoxUp);
    window.addEventListener('keydown', onBoxKey);
    el.addEventListener('contextmenu', onCtxMenu);

    map.on('click', (e) => {
      if (swallowNextClick) {
        swallowNextClick = false;
        return;
      }
      const mPerPx =
        (156543.03392 * Math.cos((e.lngLat.lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
      onPick({
        lng: e.lngLat.lng,
        lat: e.lngLat.lat,
        radiusM: mPerPx * pickRadius(),
        x: e.point.x,
        y: e.point.y,
      });
    });

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
      getBounds: () => {
        const b = map.getBounds();
        // Shrunk by exactly the padding every restore adds back. Handing back the raw visible
        // extent and re-fitting it into a viewport 2 * PAD narrower loses a fraction of a zoom
        // level on each reload, and the map walks steadily outwards from where it was left.
        const el = map.getContainer();
        const dx = el.clientWidth > 2 * FIT_PAD ? ((b.getEast() - b.getWest()) * FIT_PAD) / el.clientWidth : 0;
        const dy =
          el.clientHeight > 2 * FIT_PAD ? ((b.getNorth() - b.getSouth()) * FIT_PAD) / el.clientHeight : 0;
        return [b.getWest() + dx, b.getSouth() + dy, b.getEast() - dx, b.getNorth() - dy];
      },
      flyToBounds: (bb, durationMs = 900) => {
        framed.current = bb;
        easeToBounds(
          map,
          [
            [bb[0], bb[1]],
            [bb[2], bb[3]],
          ],
          { padding: FIT_PAD, duration: durationMs },
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
        framed.current = bb;
        easeToBounds(
          map,
          [
            [bb[0], bb[1]],
            [bb[2], bb[3]],
          ],
          { padding: FIT_PAD, duration: 700 },
        );
      },
    };

    map.once('load', () => onReady(handles));
    // Hand over handles even if the basemap never loads.
    const t = window.setTimeout(() => onReady(handles), 4000);
    return () => {
      window.clearTimeout(watchdog);
      document.removeEventListener('visibilitychange', onVisible);
      ro.disconnect();
      window.clearTimeout(t);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointerdown', onBoxDown);
      window.removeEventListener('pointermove', onBoxMove);
      window.removeEventListener('pointerup', onBoxUp);
      window.removeEventListener('keydown', onBoxKey);
      el.removeEventListener('contextmenu', onCtxMenu);
      deck.finalize();
      deckRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(rebuild, [mode]);

  /**
   * Relief shading from a raster-dem source.
   *
   * Re-applied on every `styledata`, not just once: setStyle() replaces the entire style
   * document, so a theme change takes the source and the layer with it. The layer is inserted
   * beneath the first symbol layer so place names stay legible on top of the terrain rather
   * than being shaded along with it.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      if (!map.isStyleLoaded()) return;
      const has = Boolean(map.getLayer('um-hillshade'));

      if (!hillshade) {
        if (has) map.removeLayer('um-hillshade');
        if (map.getSource('um-dem')) map.removeSource('um-dem');
        return;
      }
      if (has) return;

      if (!map.getSource('um-dem')) {
        map.addSource('um-dem', {
          type: 'raster-dem',
          tiles: [TERRAIN_TILES],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 13,
          attribution: 'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
        });
      }
      const firstSymbol = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id;
      map.addLayer(
        {
          id: 'um-hillshade',
          type: 'hillshade',
          source: 'um-dem',
          paint: {
            // Strong enough to read as terrain, restrained enough not to compete with the
            // gold. On the light basemap the highlight does almost nothing -- the surface is
            // already near-white -- so the relief has to come from the shadow side.
            'hillshade-exaggeration': theme === 'light' ? 0.6 : 0.45,
            'hillshade-shadow-color': theme === 'light' ? '#46505f' : '#000000',
            'hillshade-highlight-color': theme === 'light' ? '#ffffff' : '#9db0cf',
            'hillshade-accent-color': theme === 'light' ? '#6f7885' : '#0a0d12',
          },
        },
        firstSymbol,
      );
    };

    apply();
    map.on('styledata', apply);
    return () => {
      map.off('styledata', apply);
    };
  }, [hillshade, theme]);

  /**
   * Swap the basemap with the surface.
   *
   * Safe to do bluntly because deck.gl draws on its own canvas rather than as a layer inside
   * MapLibre's style -- setStyle() tears down every layer the style owns, and the coverage
   * geometry is simply not one of them. The applied-theme ref keeps the initial mount from
   * refetching a style the map was already constructed with.
   */
  const appliedTheme = useRef<Theme | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (appliedTheme.current === null) {
      appliedTheme.current = theme;
      return;
    }
    if (appliedTheme.current === theme) return;
    appliedTheme.current = theme;
    // Back to the preferred provider: whichever one is serving now was chosen for the old
    // surface, and a provider that failed a minute ago may well be back.
    styleIndex.current = 0;
    map.setStyle(BASEMAP_STYLES[theme][0]);
  }, [theme]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={container} style={{ position: 'absolute', inset: 0 }} />
      <canvas
        ref={deckCanvas}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />
      <div ref={boxEl} className="zoom-box" />
    </div>
  );
}
