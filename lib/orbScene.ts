import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import {
  DEFAULT_ENERGY_THEME,
  ENERGY_THEMES,
  type EnergyThemeId,
} from "@/lib/ultron/themes";

export type OrbActivityMode = "idle" | "listening" | "processing" | "alert";

export interface CreateOrbSceneOptions {
  initialTheme?: EnergyThemeId;
}

export interface SetThemeOptions {
  immediate?: boolean;
}

export interface OrbSceneApi {
  /** Rotate the camera around the orb by the given angles (radians). */
  rotateBy(deltaTheta: number, deltaPhi: number): void;
  /** Multiply the camera distance by `factor` (<1 zooms in, >1 zooms out). */
  zoomBy(factor: number): void;
  zoomIn(): void;
  zoomOut(): void;
  resetView(): void;
  setActivityMode(mode: OrbActivityMode): void;
  setTheme(themeId: EnergyThemeId, options?: SetThemeOptions): void;
  dispose(): void;
}

type ColorRole = "bright" | "mid" | "dim" | "faint" | "hot";

const HOME_POSITION = new THREE.Vector3(0, 0.5, 5.5);
const MIN_DISTANCE = 0.6;
const MAX_DISTANCE = 40;

export function createOrbScene(
  container: HTMLElement,
  options: CreateOrbSceneOptions = {},
): OrbSceneApi {
  const width = Math.max(container.clientWidth, 1);
  const height = Math.max(container.clientHeight, 1);

  const initialThemeId = options.initialTheme ?? DEFAULT_ENERGY_THEME;
  const initialSpec = ENERGY_THEMES[initialThemeId];

  const isSoftwareGl = (() => {
    try {
      const probeCanvas = document.createElement("canvas");
      const gl = probeCanvas.getContext("webgl2");
      if (!gl) return true;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    } catch {
      return false;
    }
  })();

  // ——— SCENE ———
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 500);
  camera.position.copy(HOME_POSITION);

  const renderer = new THREE.WebGLRenderer({
    antialias: !isSoftwareGl,
    powerPreference: "high-performance",
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  container.appendChild(renderer.domElement);

  // ——— DYNAMIC THEME PALETTE STATE ———
  const roleMaterials: Record<ColorRole, Array<{ color: THREE.Color }>> = {
    bright: [],
    mid: [],
    dim: [],
    faint: [],
    hot: [],
  };

  const currentColors: Record<ColorRole, THREE.Color> = {
    bright: new THREE.Color(initialSpec.orbColors.bright),
    mid: new THREE.Color(initialSpec.orbColors.mid),
    dim: new THREE.Color(initialSpec.orbColors.dim),
    faint: new THREE.Color(initialSpec.orbColors.faint),
    hot: new THREE.Color(initialSpec.orbColors.hot),
  };

  const startColors: Record<ColorRole, THREE.Color> = {
    bright: currentColors.bright.clone(),
    mid: currentColors.mid.clone(),
    dim: currentColors.dim.clone(),
    faint: currentColors.faint.clone(),
    hot: currentColors.hot.clone(),
  };

  const targetColors: Record<ColorRole, THREE.Color> = {
    bright: currentColors.bright.clone(),
    mid: currentColors.mid.clone(),
    dim: currentColors.dim.clone(),
    faint: currentColors.faint.clone(),
    hot: currentColors.hot.clone(),
  };

  const startShaderChannel = new THREE.Vector3(...initialSpec.shader.channelWeight);
  const startShaderTint = new THREE.Vector3(...initialSpec.shader.tint);
  let startShaderMix = initialSpec.shader.tintMix;
  const targetShaderChannel = new THREE.Vector3(...initialSpec.shader.channelWeight);
  const targetShaderTint = new THREE.Vector3(...initialSpec.shader.tint);
  let targetShaderMix = initialSpec.shader.tintMix;
  let colorTransitioning = false;
  let transitionStartSec = 0;
  const TRANSITION_DURATION_SEC = 0.45;
  let themePulse = 0;

  // ——— POST PROCESSING (GPU path) ———
  const composer = isSoftwareGl ? null : new EffectComposer(renderer);
  if (composer) {
    composer.addPass(new RenderPass(scene, camera));
  }

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    1.8, // strength
    0.4, // radius
    0.2, // threshold
  );
  composer?.addPass(bloom);

  // Chromatic aberration + dynamic energy core color grade shader
  const chromaticShader = {
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uIntensity: { value: 0.003 },
      uChannelWeight: {
        value: new THREE.Vector3(...initialSpec.shader.channelWeight),
      },
      uTint: { value: new THREE.Vector3(...initialSpec.shader.tint) },
      uTintMix: { value: initialSpec.shader.tintMix },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform float uIntensity;
      uniform vec3 uChannelWeight;
      uniform vec3 uTint;
      uniform float uTintMix;
      varying vec2 vUv;
      void main() {
        vec2 dir = vUv - vec2(0.5);
        float d = length(dir);
        float offset = uIntensity * d;
        // Slight flicker
        float flicker = 1.0 + 0.02 * sin(uTime * 30.0) * sin(uTime * 7.3);
        vec4 cr = texture2D(tDiffuse, vUv + dir * offset);
        vec4 cg = texture2D(tDiffuse, vUv);
        vec4 cb = texture2D(tDiffuse, vUv - dir * offset * 0.5);
        gl_FragColor = vec4(
          cr.r * uChannelWeight.x,
          cg.g * uChannelWeight.y,
          cb.b * uChannelWeight.z,
          1.0
        ) * flicker;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * uTint, uTintMix);
      }
    `,
  };
  const chromaticPass = new ShaderPass(chromaticShader);
  composer?.addPass(chromaticPass);

  // Controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.04;
  controls.minDistance = MIN_DISTANCE;
  controls.maxDistance = MAX_DISTANCE;
  controls.zoomSpeed = 1.4;
  controls.enablePan = false;

  // ——— ORB ROOT ———
  // Every part of the orb (shells, core, orbiting debris, text, dust, rings)
  // lives under this group.
  const orbGroup = new THREE.Group();
  scene.add(orbGroup);

  // ——— MATERIAL HELPERS ———
  function registerMat<T extends { color: THREE.Color }>(role: ColorRole, mat: T): T {
    mat.color.copy(currentColors[role]);
    roleMaterials[role].push(mat);
    return mat;
  }

  function lineMat(role: ColorRole, opacity = 1) {
    return registerMat(
      role,
      new THREE.LineBasicMaterial({
        color: currentColors[role].getHex(),
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
  }

  // ——— UTILITY: Create ring at latitude ———
  function latRing(radius: number, lat: number, segs = 120) {
    const r = radius * Math.cos(lat);
    const y = radius * Math.sin(lat);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a)));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  // ——— UTILITY: Create meridian ———
  function meridian(radius: number, lon: number, segs = 120) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segs; i++) {
      const lat = (i / segs) * Math.PI - Math.PI / 2;
      pts.push(
        new THREE.Vector3(
          radius * Math.cos(lat) * Math.cos(lon),
          radius * Math.sin(lat),
          radius * Math.cos(lat) * Math.sin(lon),
        ),
      );
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  // ═══════════════════════════════════════════════
  // LAYER 1: OUTER SHELL — dense wireframe grid
  // ═══════════════════════════════════════════════
  const outerShell = new THREE.Group();
  const R1 = 2.0;

  // Dense latitude rings (30+)
  for (let i = -15; i <= 15; i++) {
    const lat = (i / 15) * (Math.PI / 2) * 0.95;
    const opacity = i % 3 === 0 ? 0.5 : 0.12;
    const role: ColorRole = i % 3 === 0 ? "mid" : "faint";
    outerShell.add(new THREE.Line(latRing(R1, lat), lineMat(role, opacity)));
  }

  // Dense meridians (24)
  for (let i = 0; i < 24; i++) {
    const lon = (i / 24) * Math.PI * 2;
    const isMajor = i % 6 === 0;
    outerShell.add(
      new THREE.Line(
        meridian(R1, lon),
        lineMat(isMajor ? "mid" : "faint", isMajor ? 0.6 : 0.1),
      ),
    );
  }

  // 4 bright cross meridians (the "plus" shape) — wide bands
  const CROSS_LINES = 18;
  const CROSS_SPREAD = 0.25; // radians total width
  for (let i = 0; i < 4; i++) {
    const lon = (i / 4) * Math.PI * 2;
    for (let j = 0; j < CROSS_LINES; j++) {
      const t = (j / (CROSS_LINES - 1)) * 2 - 1; // -1 to 1
      const offset = (t * CROSS_SPREAD) / 2;
      const falloff = 1 - Math.abs(t) * 0.7; // brighter at center, dimmer at edges
      const opacity = 0.85 * falloff;
      const role: ColorRole = Math.abs(t) < 0.3 ? "bright" : "mid";
      outerShell.add(
        new THREE.Line(meridian(R1, lon + offset, 200), lineMat(role, opacity)),
      );
    }
  }

  // Bright equator band — wide
  const EQ_LINES = 20;
  const EQ_SPREAD = 0.35;
  for (let j = 0; j < EQ_LINES; j++) {
    const t = (j / (EQ_LINES - 1)) * 2 - 1;
    const offset = (t * EQ_SPREAD) / 2;
    const falloff = 1 - Math.abs(t) * 0.65;
    const opacity = 0.8 * falloff;
    const role: ColorRole = Math.abs(t) < 0.3 ? "bright" : "mid";
    outerShell.add(
      new THREE.Line(latRing(R1, offset, 200), lineMat(role, opacity)),
    );
  }

  orbGroup.add(outerShell);

  // ═══════════════════════════════════════════════
  // LAYER 2: GRID PANELS on the sphere surface
  // ═══════════════════════════════════════════════
  const panelGroup = new THREE.Group();

  function createSpherePanel(
    latCenter: number,
    lonCenter: number,
    latSpan: number,
    lonSpan: number,
    radius: number,
    divisions = 4,
  ) {
    const group = new THREE.Group();
    const mat = lineMat("dim", 0.25);

    // horizontal lines
    for (let i = 0; i <= divisions; i++) {
      const lat = latCenter - latSpan / 2 + (i / divisions) * latSpan;
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= divisions * 4; j++) {
        const lon = lonCenter - lonSpan / 2 + (j / (divisions * 4)) * lonSpan;
        pts.push(
          new THREE.Vector3(
            radius * Math.cos(lat) * Math.cos(lon),
            radius * Math.sin(lat),
            radius * Math.cos(lat) * Math.sin(lon),
          ),
        );
      }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }

    // vertical lines
    for (let j = 0; j <= divisions; j++) {
      const lon = lonCenter - lonSpan / 2 + (j / divisions) * lonSpan;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= divisions * 4; i++) {
        const lat = latCenter - latSpan / 2 + (i / (divisions * 4)) * latSpan;
        pts.push(
          new THREE.Vector3(
            radius * Math.cos(lat) * Math.cos(lon),
            radius * Math.sin(lat),
            radius * Math.cos(lat) * Math.sin(lon),
          ),
        );
      }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }

    return group;
  }

  // Scatter panels across the sphere
  for (let i = 0; i < 30; i++) {
    const lat = (Math.random() - 0.5) * Math.PI * 0.8;
    const lon = Math.random() * Math.PI * 2;
    const size = 0.15 + Math.random() * 0.25;
    const panel = createSpherePanel(
      lat,
      lon,
      size,
      size,
      R1 + 0.01,
      3 + Math.floor(Math.random() * 3),
    );
    panelGroup.add(panel);
  }
  orbGroup.add(panelGroup);

  // ═══════════════════════════════════════════════
  // LAYER 3: SECONDARY SHELL — offset, partial arcs
  // ═══════════════════════════════════════════════
  const shell2 = new THREE.Group();
  const R2 = 2.12;

  // Partial arcs at random latitudes
  for (let i = 0; i < 16; i++) {
    const lat = (Math.random() - 0.5) * Math.PI * 0.85;
    const startLon = Math.random() * Math.PI * 2;
    const arcLen = 0.3 + Math.random() * 1.2;
    const pts: THREE.Vector3[] = [];
    const segs = 60;
    const r = R2 * Math.cos(lat);
    const y = R2 * Math.sin(lat);
    for (let j = 0; j <= segs; j++) {
      const a = startLon + (j / segs) * arcLen;
      pts.push(new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a)));
    }
    shell2.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        lineMat("mid", 0.2 + Math.random() * 0.3),
      ),
    );
  }

  // Partial meridian arcs
  for (let i = 0; i < 12; i++) {
    const lon = Math.random() * Math.PI * 2;
    const startLat = (Math.random() - 0.5) * Math.PI * 0.8;
    const arcLen = 0.3 + Math.random() * 0.8;
    const pts: THREE.Vector3[] = [];
    const segs = 40;
    for (let j = 0; j <= segs; j++) {
      const lat = startLat + (j / segs) * arcLen;
      pts.push(
        new THREE.Vector3(
          R2 * Math.cos(lat) * Math.cos(lon),
          R2 * Math.sin(lat),
          R2 * Math.cos(lat) * Math.sin(lon),
        ),
      );
    }
    shell2.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        lineMat("dim", 0.15 + Math.random() * 0.2),
      ),
    );
  }
  orbGroup.add(shell2);

  // ═══════════════════════════════════════════════
  // LAYER 4: INNER CORE — spiral geodesic
  // ═══════════════════════════════════════════════
  const innerCore = new THREE.Group();
  const R3 = 0.9;

  // Dense spirals
  for (let s = 0; s < 8; s++) {
    const pts: THREE.Vector3[] = [];
    const turns = 3 + Math.random() * 2;
    const segs = 300;
    const phase = (s / 8) * Math.PI * 2;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const lat = t * Math.PI - Math.PI / 2;
      const lon = t * turns * Math.PI * 2 + phase;
      pts.push(
        new THREE.Vector3(
          R3 * Math.cos(lat) * Math.cos(lon),
          R3 * Math.sin(lat),
          R3 * Math.cos(lat) * Math.sin(lon),
        ),
      );
    }
    innerCore.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        lineMat("bright", 0.3 + Math.random() * 0.2),
      ),
    );
  }

  // Inner latitude rings
  for (let i = -6; i <= 6; i++) {
    const lat = (i / 6) * (Math.PI / 2) * 0.9;
    innerCore.add(new THREE.Line(latRing(R3, lat, 80), lineMat("dim", 0.2)));
  }

  // Inner meridians
  for (let i = 0; i < 12; i++) {
    const lon = (i / 12) * Math.PI * 2;
    innerCore.add(new THREE.Line(meridian(R3, lon, 80), lineMat("dim", 0.15)));
  }

  orbGroup.add(innerCore);

  // ═══════════════════════════════════════════════
  // LAYER 5: INNERMOST CORE — bright hot center + atmospheric plasma aura
  // ═══════════════════════════════════════════════
  const coreR = 0.25;

  // Icosahedron wireframe core
  const icoGeo = new THREE.IcosahedronGeometry(coreR, 1);
  const icoEdges = new THREE.EdgesGeometry(icoGeo);
  const icoWireMat = lineMat("hot", 0.9);
  const icoWire = new THREE.LineSegments(icoEdges, icoWireMat);
  orbGroup.add(icoWire);

  // Glowing center sphere — subtle, see-through
  const coreSphereMat = registerMat(
    "hot",
    new THREE.MeshBasicMaterial({
      color: currentColors.hot.getHex(),
      transparent: true,
      opacity: 0.15,
      blending: THREE.AdditiveBlending,
    }),
  );
  const coreSphere = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 16), coreSphereMat);
  orbGroup.add(coreSphere);

  // Larger faint glow — very subtle
  const glowSphereMat = registerMat(
    "mid",
    new THREE.MeshBasicMaterial({
      color: currentColors.mid.getHex(),
      transparent: true,
      opacity: 0.04,
      blending: THREE.AdditiveBlending,
    }),
  );
  const glowSphere = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 16), glowSphereMat);
  orbGroup.add(glowSphere);

  // Soft atmospheric plasma halo sprites (white alpha tinted dynamically by theme)
  const haloCanvas = document.createElement("canvas");
  haloCanvas.width = haloCanvas.height = 128;
  const haloCtx = haloCanvas.getContext("2d")!;
  const haloGrad = haloCtx.createRadialGradient(64, 64, 0, 64, 64, 64);
  haloGrad.addColorStop(0, "rgba(255,255,255,0.95)");
  haloGrad.addColorStop(0.25, "rgba(255,255,255,0.45)");
  haloGrad.addColorStop(0.6, "rgba(255,255,255,0.12)");
  haloGrad.addColorStop(1, "rgba(255,255,255,0)");
  haloCtx.fillStyle = haloGrad;
  haloCtx.fillRect(0, 0, 128, 128);
  const haloTex = new THREE.CanvasTexture(haloCanvas);

  const auraInnerMat = registerMat(
    "hot",
    new THREE.SpriteMaterial({
      map: haloTex,
      color: currentColors.hot.getHex(),
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const auraInnerSprite = new THREE.Sprite(auraInnerMat);
  auraInnerSprite.scale.set(1.4, 1.4, 1);
  orbGroup.add(auraInnerSprite);

  const auraOuterMat = registerMat(
    "mid",
    new THREE.SpriteMaterial({
      map: haloTex,
      color: currentColors.mid.getHex(),
      transparent: true,
      opacity: 0.09,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const auraOuterSprite = new THREE.Sprite(auraOuterMat);
  auraOuterSprite.scale.set(5.2, 5.2, 1);
  orbGroup.add(auraOuterSprite);

  // ═══════════════════════════════════════════════
  // CODE TEXT — tiny, dense, scattered
  // ═══════════════════════════════════════════════
  const codeSnippets = [
    "sys.init()", "0xFF3A", "malloc()", ">> SCAN", "void*", "ACK",
    "SYNC OK", "ptr_ref", "exec()", "hash256", "::bind", "core.0",
    "01101001", "10110100", ">>> RDY", "HEAP 4K", "TCP/SYN",
    "mutex.lk", "IRQ 0x7", "DMA xfer", "REG EAX", "FAULT 0",
    "kernel.d", "pipe |>", "chmod +x", "fork()", "SIGTERM",
    "eth0: UP", "AES-256", "RSA 4096", "TLS 1.3", "HTTP/2",
    "latency", "200 OK", "PATCH /", "fn main", "use std",
    "impl Orb", "async {}", "spawn()", "arc::new", ".unwrap",
  ];

  interface SpriteDrift {
    phi: number;
    theta: number;
    r: number;
    speed: number;
  }

  function makeTextSprite(text: string, size = 0.08) {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 32;
    const ctx = c.getContext("2d")!;
    ctx.font = "bold 14px Courier New";
    const alpha = 0.35 + Math.random() * 0.55;
    // White-alpha canvas so SpriteMaterial color lerps across any energy theme
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 16);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    const roleRoll = Math.random();
    const role: ColorRole =
      roleRoll > 0.85 ? "hot" : roleRoll > 0.3 ? "bright" : "mid";
    const mat = registerMat(
      role,
      new THREE.SpriteMaterial({
        map: tex,
        color: currentColors[role].getHex(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const s = new THREE.Sprite(mat);
    s.scale.set(size * 5, size * 0.7, 1);
    return s;
  }

  function scatterText(
    count: number,
    sizeFn: () => number,
    rFn: () => number,
    speedScale: [number, number],
  ) {
    const group = new THREE.Group();
    for (let i = 0; i < count; i++) {
      const sp = makeTextSprite(
        codeSnippets[Math.floor(Math.random() * codeSnippets.length)],
        sizeFn(),
      );
      const phi = Math.acos(2 * Math.random() - 1);
      const theta = Math.random() * Math.PI * 2;
      const r = rFn();
      sp.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      );
      sp.userData = {
        phi,
        theta,
        r,
        speed:
          (speedScale[0] + Math.random() * speedScale[1]) *
          (Math.random() > 0.5 ? 1 : -1),
      } satisfies SpriteDrift;
      group.add(sp);
    }
    return group;
  }

  // On outer sphere — dense text coverage
  const textOuter = scatterText(
    1200,
    () => 0.04 + Math.random() * 0.04,
    () => R1 + 0.03 + Math.random() * 0.08,
    [0.0002, 0.0008],
  );
  orbGroup.add(textOuter);

  // On inner core — more text
  const textInner = scatterText(
    100,
    () => 0.03 + Math.random() * 0.03,
    () => R3 + 0.02,
    [0.0005, 0.001],
  );
  orbGroup.add(textInner);

  // Floating ambient text between shells
  const textAmbient = scatterText(
    400,
    () => 0.03,
    () => R3 + 0.2 + Math.random() * (R1 - R3 - 0.3),
    [0.0003, 0.0006],
  );
  orbGroup.add(textAmbient);

  // ═══════════════════════════════════════════════
  // ORBITING DEBRIS / ROCKS
  // ═══════════════════════════════════════════════
  // Shared geometries for performance — reuse across 250 satellites
  const debrisGeos = [
    new THREE.IcosahedronGeometry(0.012, 0),
    new THREE.IcosahedronGeometry(0.02, 0),
    new THREE.IcosahedronGeometry(0.03, 1),
    new THREE.IcosahedronGeometry(0.008, 0),
    new THREE.TetrahedronGeometry(0.015, 0),
    new THREE.OctahedronGeometry(0.018, 0),
  ];
  interface DebrisOrbit {
    orbitR: number;
    speed: number;
    tiltX: number;
    tiltZ: number;
    phase: number;
  }
  const debris: THREE.Mesh[] = [];
  for (let i = 0; i < 250; i++) {
    const geo = debrisGeos[Math.floor(Math.random() * debrisGeos.length)];
    const role: ColorRole = Math.random() > 0.7 ? "bright" : "mid";
    const mat = registerMat(
      role,
      new THREE.MeshBasicMaterial({
        color: currentColors[role].getHex(),
        transparent: true,
        opacity: 0.3 + Math.random() * 0.6,
        blending: THREE.AdditiveBlending,
      }),
    );
    const mesh = new THREE.Mesh(geo, mat);
    const orbitR = 1.2 + Math.random() * 4.0;
    const speed = (0.08 + Math.random() * 0.6) * (Math.random() > 0.5 ? 1 : -1);
    const tiltX = (Math.random() - 0.5) * Math.PI * 0.9;
    const tiltZ = (Math.random() - 0.5) * Math.PI * 0.5;
    const phase = Math.random() * Math.PI * 2;
    mesh.userData = { orbitR, speed, tiltX, tiltZ, phase } satisfies DebrisOrbit;
    debris.push(mesh);
    orbGroup.add(mesh);

    // ~15% get a faint trailing line
    if (Math.random() > 0.85) {
      const trailPts: THREE.Vector3[] = [];
      for (let j = 0; j <= 15; j++) {
        const a = -(j / 15) * 0.3;
        trailPts.push(
          new THREE.Vector3(
            orbitR * Math.cos(a + phase),
            orbitR * 0.08 * Math.sin(a * 3),
            orbitR * Math.sin(a + phase),
          ),
        );
      }
      const trail = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(trailPts),
        lineMat("faint", 0.08),
      );
      mesh.add(trail);
    }
  }

  // ═══════════════════════════════════════════════
  // DUST PARTICLES — lots of them
  // ═══════════════════════════════════════════════
  const dustCount = 2000;
  const dustPos = new Float32Array(dustCount * 3);

  for (let i = 0; i < dustCount; i++) {
    // Concentrate near the sphere, sparse further out
    const rr = 0.5 + Math.pow(Math.random(), 0.6) * 7;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    dustPos[i * 3] = rr * Math.sin(phi) * Math.cos(theta);
    dustPos[i * 3 + 1] = rr * Math.cos(phi);
    dustPos[i * 3 + 2] = rr * Math.sin(phi) * Math.sin(theta);
  }

  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.Float32BufferAttribute(dustPos, 3));

  // Soft white radial dot texture so dustMat.color tints cleanly per theme
  const dotC = document.createElement("canvas");
  dotC.width = dotC.height = 64;
  const dCtx = dotC.getContext("2d")!;
  const g = dCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.2, "rgba(255,255,255,0.65)");
  g.addColorStop(0.5, "rgba(255,255,255,0.18)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  dCtx.fillStyle = g;
  dCtx.fillRect(0, 0, 64, 64);

  const dustMat = registerMat(
    "bright",
    new THREE.PointsMaterial({
      map: new THREE.CanvasTexture(dotC),
      size: 0.04,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      color: currentColors.bright.getHex(),
    }),
  );
  const dustPoints = new THREE.Points(dustGeo, dustMat);
  orbGroup.add(dustPoints);

  // ═══════════════════════════════════════════════
  // SCANNING RINGS
  // ═══════════════════════════════════════════════
  function makeScanRing(radius: number, thickness = 0.015) {
    const geo = new THREE.RingGeometry(radius - thickness, radius + thickness, 120);
    const mat = registerMat(
      "bright",
      new THREE.MeshBasicMaterial({
        color: currentColors.bright.getHex(),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = Math.PI / 2;
    return mesh;
  }

  const scanRing1 = makeScanRing(R1, 0.01);
  const scanRing2 = makeScanRing(R1 * 0.7, 0.008);
  orbGroup.add(scanRing1, scanRing2);

  // ═══════════════════════════════════════════════
  // HEXAGONAL NODES — small tech details
  // ═══════════════════════════════════════════════
  for (let i = 0; i < 15; i++) {
    const phi = Math.acos(2 * Math.random() - 1);
    const theta = Math.random() * Math.PI * 2;
    const r = R1 + 0.02;
    const hexGeo = new THREE.CircleGeometry(0.03 + Math.random() * 0.02, 6);
    const hexEdges = new THREE.EdgesGeometry(hexGeo);
    const hex = new THREE.LineSegments(hexEdges, lineMat("mid", 0.5));
    hex.position.set(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(theta),
    );
    hex.lookAt(0, 0, 0);
    outerShell.add(hex);
  }

  // ═══════════════════════════════════════════════
  // THEME TRANSITION CONTROLLER
  // ═══════════════════════════════════════════════
  function syncRoleMaterials() {
    const roles: ColorRole[] = ["bright", "mid", "dim", "faint", "hot"];
    for (const role of roles) {
      const col = currentColors[role];
      const mats = roleMaterials[role];
      for (let i = 0; i < mats.length; i++) {
        mats[i].color.copy(col);
      }
    }
  }

  function setTheme(themeId: EnergyThemeId, themeOpts: SetThemeOptions = {}) {
    const spec = ENERGY_THEMES[themeId] ?? ENERGY_THEMES[DEFAULT_ENERGY_THEME];
    targetColors.bright.setHex(spec.orbColors.bright);
    targetColors.mid.setHex(spec.orbColors.mid);
    targetColors.dim.setHex(spec.orbColors.dim);
    targetColors.faint.setHex(spec.orbColors.faint);
    targetColors.hot.setHex(spec.orbColors.hot);

    targetShaderChannel.set(...spec.shader.channelWeight);
    targetShaderTint.set(...spec.shader.tint);
    targetShaderMix = spec.shader.tintMix;

    if (themeOpts.immediate) {
      currentColors.bright.copy(targetColors.bright);
      currentColors.mid.copy(targetColors.mid);
      currentColors.dim.copy(targetColors.dim);
      currentColors.faint.copy(targetColors.faint);
      currentColors.hot.copy(targetColors.hot);
      startColors.bright.copy(targetColors.bright);
      startColors.mid.copy(targetColors.mid);
      startColors.dim.copy(targetColors.dim);
      startColors.faint.copy(targetColors.faint);
      startColors.hot.copy(targetColors.hot);
      chromaticPass.uniforms.uChannelWeight.value.copy(targetShaderChannel);
      chromaticPass.uniforms.uTint.value.copy(targetShaderTint);
      chromaticPass.uniforms.uTintMix.value = targetShaderMix;
      colorTransitioning = false;
      themePulse = 0;
      syncRoleMaterials();
      return;
    }

    startColors.bright.copy(currentColors.bright);
    startColors.mid.copy(currentColors.mid);
    startColors.dim.copy(currentColors.dim);
    startColors.faint.copy(currentColors.faint);
    startColors.hot.copy(currentColors.hot);
    startShaderChannel.copy(chromaticPass.uniforms.uChannelWeight.value as THREE.Vector3);
    startShaderTint.copy(chromaticPass.uniforms.uTint.value as THREE.Vector3);
    startShaderMix = chromaticPass.uniforms.uTintMix.value;
    transitionStartSec = (performance.now() - animStartMs) * 0.001;
    colorTransitioning = true;
    themePulse = 1.0;
  }

  // ═══════════════════════════════════════════════
  // GESTURE / PROGRAMMATIC CAMERA CONTROL
  // ═══════════════════════════════════════════════
  const sphericalScratch = new THREE.Spherical();
  const offsetScratch = new THREE.Vector3();

  function rotateBy(deltaTheta: number, deltaPhi: number) {
    offsetScratch.copy(camera.position).sub(controls.target);
    sphericalScratch.setFromVector3(offsetScratch);
    sphericalScratch.theta -= deltaTheta;
    sphericalScratch.phi = THREE.MathUtils.clamp(
      sphericalScratch.phi - deltaPhi,
      0.05,
      Math.PI - 0.05,
    );
    sphericalScratch.makeSafe();
    offsetScratch.setFromSpherical(sphericalScratch);
    camera.position.copy(controls.target).add(offsetScratch);
    camera.lookAt(controls.target);
  }

  function zoomBy(factor: number) {
    offsetScratch.copy(camera.position).sub(controls.target);
    const dist = THREE.MathUtils.clamp(
      offsetScratch.length() * factor,
      MIN_DISTANCE,
      MAX_DISTANCE,
    );
    offsetScratch.setLength(dist);
    camera.position.copy(controls.target).add(offsetScratch);
  }

  function resetView() {
    camera.position.copy(HOME_POSITION);
    controls.target.set(0, 0, 0);
    camera.lookAt(controls.target);
    controls.update();
  }

  // ——— ANIMATION ———
  const animStartMs = performance.now();
  let prevTime = 0;
  let flickerTimer = 0;
  let rafId = 0;
  let timeoutId = 0;
  let disposed = false;
  let contextLost = false;
  let activityMode: OrbActivityMode = "idle";

  const onContextLost = (e: Event) => {
    e.preventDefault();
    contextLost = true;
  };
  const onContextRestored = () => {
    contextLost = false;
  };
  renderer.domElement.addEventListener("webglcontextlost", onContextLost);
  renderer.domElement.addEventListener("webglcontextrestored", onContextRestored);

  function afterDraw(cb: () => void) {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (typeof gl.fenceSync !== "function") {
      timeoutId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (disposed) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        timeoutId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        timeoutId = window.setTimeout(cb, 80);
      }
    };
    timeoutId = window.setTimeout(poll, 5);
  }

  function animate() {
    if (disposed) return;
    if (contextLost) {
      timeoutId = window.setTimeout(animate, 200);
      return;
    }
    const t = (performance.now() - animStartMs) * 0.001;
    const dt = Math.min(Math.max(t - prevTime, 0.008), 0.25);
    prevTime = t;

    if (colorTransitioning) {
      const progress = Math.min(
        1,
        Math.max(0, (t - transitionStartSec) / TRANSITION_DURATION_SEC),
      );
      // Cubic ease-out for silky smooth, deterministic completion
      const eased = 1 - Math.pow(1 - progress, 3);
      const roles: ColorRole[] = ["bright", "mid", "dim", "faint", "hot"];
      for (const role of roles) {
        currentColors[role].copy(startColors[role]).lerp(targetColors[role], eased);
      }

      const uCh = chromaticPass.uniforms.uChannelWeight.value as THREE.Vector3;
      const uTn = chromaticPass.uniforms.uTint.value as THREE.Vector3;
      uCh.copy(startShaderChannel).lerp(targetShaderChannel, eased);
      uTn.copy(startShaderTint).lerp(targetShaderTint, eased);
      chromaticPass.uniforms.uTintMix.value =
        startShaderMix + (targetShaderMix - startShaderMix) * eased;

      if (progress >= 1) {
        for (const role of roles) {
          currentColors[role].copy(targetColors[role]);
        }
        uCh.copy(targetShaderChannel);
        uTn.copy(targetShaderTint);
        chromaticPass.uniforms.uTintMix.value = targetShaderMix;
        colorTransitioning = false;
      }
      syncRoleMaterials();
    }

    if (themePulse > 0) {
      themePulse = Math.max(0, themePulse - dt * 2.1);
    }

    const speedBoost =
      activityMode === "processing"
        ? 2.2
        : activityMode === "listening"
          ? 1.5
          : activityMode === "alert"
            ? 1.8
            : 1.0;

    // Outer shell rotation
    outerShell.rotation.y += 0.0015 * speedBoost;
    outerShell.rotation.x = Math.sin(t * 0.08) * 0.05;

    // Panel group follows shell but with slight offset
    panelGroup.rotation.y += 0.0018 * speedBoost;
    panelGroup.rotation.x = Math.sin(t * 0.08 + 0.5) * 0.04;

    // Secondary shell counter-rotates slowly
    shell2.rotation.y -= 0.001 * speedBoost;
    shell2.rotation.z = Math.sin(t * 0.12) * 0.03;

    // Inner core — opposite, faster
    innerCore.rotation.y -= 0.005 * speedBoost;
    innerCore.rotation.z += 0.002 * speedBoost;
    innerCore.rotation.x = Math.cos(t * 0.1) * 0.08;

    // Innermost wireframe
    icoWire.rotation.x += 0.008 * speedBoost;
    icoWire.rotation.y += 0.012 * speedBoost;

    // Core pulse — dramatic surges but mostly transparent
    const wave1 = Math.sin(t * 1.2);
    const wave3 = Math.pow(Math.max(0, Math.sin(t * 0.4)), 5); // rare big surge
    const wave4 = Math.pow(Math.max(0, Math.sin(t * 0.7 + 2)), 8); // mega surge
    const fadeOut = Math.pow(Math.max(0, Math.sin(t * 0.25)), 3); // periodic full transparency
    const surge = wave3 * 1.5 + wave4 * 2.0 + themePulse * 0.35;
    const coreScale = 1 + surge + Math.sin(t * 5) * 0.05;
    coreSphere.scale.setScalar(coreScale);
    // Opacity: mostly very low (0-0.15), sometimes fully transparent, brief bright on surge
    const coreOpacity = Math.max(
      0,
      (0.08 + wave1 * 0.05 + surge * 0.2) * (1 - fadeOut * 0.95),
    );
    coreSphereMat.opacity = Math.min(0.6, coreOpacity);
    glowSphere.scale.setScalar(1 + surge * 0.8);
    glowSphereMat.opacity = Math.max(0, (0.03 + surge * 0.08) * (1 - fadeOut * 0.9));

    // Soft atmospheric plasma lighting synced to core pulse
    auraInnerSprite.scale.setScalar(1.35 + surge * 0.32 + Math.sin(t * 2.2) * 0.06);
    auraInnerMat.opacity = Math.min(0.36, 0.16 + surge * 0.1 + themePulse * 0.12);
    auraOuterSprite.scale.setScalar(5.1 + Math.sin(t * 0.9) * 0.18 + themePulse * 0.35);
    auraOuterMat.opacity = Math.min(0.18, 0.085 + surge * 0.03 + themePulse * 0.06);

    // Icosahedron wireframe stays visible even when glow fades
    icoWire.scale.setScalar(1 + surge * 0.6);
    icoWireMat.opacity = Math.min(1, 0.5 + surge * 0.4);

    // Debris orbits
    debris.forEach((d) => {
      const u = d.userData as DebrisOrbit;
      const a = t * u.speed + u.phase;
      d.position.set(
        u.orbitR * Math.cos(a) * Math.cos(u.tiltX),
        u.orbitR * Math.sin(u.tiltX) * Math.sin(a * 0.8) + Math.sin(a * 0.3 + u.tiltZ) * 0.2,
        u.orbitR * Math.sin(a) * Math.cos(u.tiltZ),
      );
      d.rotation.x += 0.015;
      d.rotation.z += 0.01;
    });

    // Text drift
    const driftGroups: [THREE.Group, number][] = [
      [textOuter, 1],
      [textInner, 2],
      [textAmbient, 1.2],
    ];
    for (const [group, mult] of driftGroups) {
      group.children.forEach((sp) => {
        const u = sp.userData as SpriteDrift;
        u.theta += u.speed * mult;
        sp.position.set(
          u.r * Math.sin(u.phi) * Math.cos(u.theta),
          u.r * Math.cos(u.phi),
          u.r * Math.sin(u.phi) * Math.sin(u.theta),
        );
      });
    }

    // Scan rings sweeping
    const scanY1 = Math.sin(t * 0.4) * R1;
    scanRing1.position.y = scanY1;
    const scanS1 = Math.sqrt(Math.max(0, R1 * R1 - scanY1 * scanY1)) / R1;
    scanRing1.scale.set(scanS1, scanS1, 1);
    (scanRing1.material as THREE.MeshBasicMaterial).opacity = 0.2 * scanS1;

    const scanY2 = Math.sin(t * 0.6 + 2) * R3;
    scanRing2.position.y = scanY2;
    const scanS2 = Math.sqrt(Math.max(0, R3 * R3 - scanY2 * scanY2)) / R3;
    scanRing2.scale.set(scanS2, scanS2, 1);
    (scanRing2.material as THREE.MeshBasicMaterial).opacity = 0.15 * scanS2;

    // Dust rotation
    dustPoints.rotation.y += 0.0002;

    // Random flicker on some panels
    flickerTimer += 0.016;
    if (flickerTimer > 0.1) {
      flickerTimer = 0;
      panelGroup.children.forEach((p) => {
        if (Math.random() > 0.95) {
          p.visible = !p.visible;
        }
      });
    }

    // Bloom pulse
    const baseBloom = activityMode === "listening" || activityMode === "processing" ? 2.0 : 1.6;
    bloom.strength = baseBloom + Math.sin(t * 0.8 * speedBoost) * 0.3 + themePulse * 0.45;

    // Update chromatic aberration time
    chromaticPass.uniforms.uTime.value = t;

    controls.update();
    if (composer) {
      composer.render();
    } else {
      renderer.render(scene, camera);
    }

    if (isSoftwareGl) {
      afterDraw(animate);
    } else {
      rafId = requestAnimationFrame(animate);
    }
  }

  animate();

  // ——— RESIZE ———
  function onResize() {
    const w = Math.max(container.clientWidth, 1);
    const h = Math.max(container.clientHeight, 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer?.setSize(w, h);
  }
  window.addEventListener("resize", onResize);

  // ——— CLEANUP ———
  function dispose() {
    disposed = true;
    cancelAnimationFrame(rafId);
    clearTimeout(timeoutId);
    window.removeEventListener("resize", onResize);
    renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
    renderer.domElement.removeEventListener("webglcontextrestored", onContextRestored);
    controls.dispose();
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat) continue;
        const anyMat = mat as THREE.Material & { map?: THREE.Texture };
        anyMat.map?.dispose();
        mat.dispose();
      }
    });
    composer?.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    rotateBy,
    zoomBy,
    zoomIn: () => zoomBy(0.65),
    zoomOut: () => zoomBy(1.55),
    resetView,
    setActivityMode: (mode: OrbActivityMode) => {
      activityMode = mode;
    },
    setTheme,
    dispose,
  };
}
