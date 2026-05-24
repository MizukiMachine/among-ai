import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import type { GameEventType, Phase } from "../game/types";

const BASE_URL = import.meta.env?.BASE_URL ?? "/";
const ASSET_ROOT = `${BASE_URL}assets/scifi-stage`;
const TEXTURE_FILE_PATTERN = /^T_.*\.png$/i;

type StageTone = "setup" | "day" | "night" | "vote" | "summary" | "danger";

interface SciFiStageBackdropProps {
  eventType?: GameEventType;
  phase?: Phase;
  secret?: boolean;
}

interface ToneConfig {
  accent: string;
  secondary: string;
  fill: string;
  alienOpacity: number;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
}

const toneConfig: Record<StageTone, ToneConfig> = {
  setup: {
    accent: "#35d082",
    secondary: "#5eead4",
    fill: "#062a25",
    alienOpacity: 0,
    cameraX: 5.2,
    cameraY: 2.8,
    cameraZ: 7.3
  },
  day: {
    accent: "#35d082",
    secondary: "#67e8f9",
    fill: "#08253a",
    alienOpacity: 0,
    cameraX: 5.4,
    cameraY: 2.75,
    cameraZ: 7
  },
  night: {
    accent: "#fb7185",
    secondary: "#a78bfa",
    fill: "#210e1a",
    alienOpacity: 0.42,
    cameraX: 4.8,
    cameraY: 2.55,
    cameraZ: 6.8
  },
  vote: {
    accent: "#f59e0b",
    secondary: "#fb7185",
    fill: "#24180a",
    alienOpacity: 0.18,
    cameraX: 5.6,
    cameraY: 2.85,
    cameraZ: 7.1
  },
  summary: {
    accent: "#86efac",
    secondary: "#38bdf8",
    fill: "#082f49",
    alienOpacity: 0.08,
    cameraX: 5,
    cameraY: 2.9,
    cameraZ: 7.6
  },
  danger: {
    accent: "#ef4444",
    secondary: "#f97316",
    fill: "#260c0c",
    alienOpacity: 0.62,
    cameraX: 4.5,
    cameraY: 2.45,
    cameraZ: 6.5
  }
};

function stageToneForEvent(phase: Phase | undefined, eventType: GameEventType | undefined, secret: boolean | undefined): StageTone {
  if (secret || phase === "werewolf_discussion" || phase === "night" || phase === "guard_action" || phase === "seer_action" || phase === "witch_action") {
    return eventType === "death" ? "danger" : "night";
  }
  if (eventType === "death" || eventType === "warning") {
    return "danger";
  }
  if (eventType === "vote_cast" || eventType === "vote_result" || phase === "voting") {
    return "vote";
  }
  if (eventType === "round_summary" || eventType === "game_ended" || phase === "ended") {
    return "summary";
  }
  if (!phase || phase === "setup") {
    return "setup";
  }
  return "day";
}

function assetPath(folder: "Aliens" | "Columns" | "Platforms" | "Props" | "Walls", name: string): string {
  return `${ASSET_ROOT}/glTF/${folder}/${name}.gltf`;
}

function fileNameFromUrl(url: string): string {
  const withoutQuery = url.split("?")[0] ?? url;
  return withoutQuery.substring(withoutQuery.lastIndexOf("/") + 1);
}

function isMesh(object: THREE.Object3D): object is THREE.Mesh {
  return (object as THREE.Mesh).isMesh === true;
}

function materialList(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material)) {
    if (value && typeof value === "object" && "isTexture" in value) {
      (value as THREE.Texture).dispose();
    }
  }
  material.dispose();
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!isMesh(object)) {
      return;
    }
    object.geometry.dispose();
    for (const material of materialList(object.material)) {
      disposeMaterial(material);
    }
  });
}

function prepareModel(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!isMesh(object)) {
      return;
    }
    object.castShadow = false;
    object.receiveShadow = true;
    for (const material of materialList(object.material)) {
      if (material instanceof THREE.MeshStandardMaterial) {
        material.roughness = Math.max(material.roughness, 0.64);
        material.metalness = Math.min(Math.max(material.metalness, 0.34), 0.88);
      }
    }
  });
}

function setObjectOpacity(root: THREE.Object3D, opacity: number): void {
  root.traverse((object) => {
    if (!isMesh(object)) {
      return;
    }
    for (const material of materialList(object.material)) {
      material.transparent = opacity < 0.98;
      material.opacity = opacity;
    }
  });
}

function visibleBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();

  root.traverse((object) => {
    if (!isMesh(object) || !object.geometry) {
      return;
    }
    object.geometry.computeBoundingBox();
    const meshBox = object.geometry.boundingBox?.clone();
    if (!meshBox) {
      return;
    }
    meshBox.applyMatrix4(object.matrixWorld);
    box.union(meshBox);
  });

  return box.isEmpty() ? new THREE.Box3().setFromObject(root) : box;
}

function normalizeVisibleHeight(root: THREE.Object3D, targetHeight: number): void {
  root.position.set(0, 0, 0);
  root.updateMatrixWorld(true);

  const box = visibleBounds(root);
  const size = box.getSize(new THREE.Vector3());
  if (size.y > 0) {
    root.scale.multiplyScalar(targetHeight / size.y);
  }

  root.updateMatrixWorld(true);
  const scaled = visibleBounds(root);
  root.position.y += -scaled.min.y;
  root.updateMatrixWorld(true);
}

function clonePrepared(root: THREE.Object3D): THREE.Object3D {
  const clone = root.clone(true);
  prepareModel(clone);
  return clone;
}

async function loadPrepared(loader: GLTFLoader, path: string): Promise<GLTF> {
  const gltf = await loader.loadAsync(path);
  prepareModel(gltf.scene);
  return gltf;
}

function playFirstAnimation(gltf: GLTF, mixers: THREE.AnimationMixer[]): void {
  const clip = gltf.animations[0];
  if (!clip) {
    return;
  }
  const mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(clip).play();
  mixers.push(mixer);
}

export function SciFiStageBackdrop({ eventType, phase, secret }: SciFiStageBackdropProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toneRef = useRef<StageTone>(stageToneForEvent(phase, eventType, secret));

  const tone = stageToneForEvent(phase, eventType, secret);
  toneRef.current = tone;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }
    const rootElement = container;

    let disposed = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2("#051017", 0.055);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 80);
    camera.position.set(5.2, 2.8, 7.2);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "high-performance" });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.domElement.className = "scifi-stage-canvas";
    renderer.domElement.setAttribute("aria-hidden", "true");
    rootElement.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight("#b8fff2", 0.82);
    const hemiLight = new THREE.HemisphereLight("#88fff0", "#051017", 1.8);
    const keyLight = new THREE.DirectionalLight("#ffffff", 2.4);
    keyLight.position.set(3.8, 5.2, 4.8);
    const accentLight = new THREE.PointLight("#35d082", 4.4, 14, 1.5);
    accentLight.position.set(-3.4, 1.4, 1.6);
    scene.add(ambientLight, hemiLight, keyLight, accentLight);

    const stageGroup = new THREE.Group();
    const alienGroup = new THREE.Group();
    const hologramGroup = new THREE.Group();
    scene.add(stageGroup, alienGroup, hologramGroup);

    const hologramMaterial = new THREE.MeshBasicMaterial({
      color: toneConfig.setup.accent,
      transparent: true,
      opacity: 0.34,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const ringGeometry = new THREE.TorusGeometry(1.05, 0.012, 8, 90);
    const ringA = new THREE.Mesh(ringGeometry, hologramMaterial);
    const ringB = new THREE.Mesh(ringGeometry, hologramMaterial);
    ringA.position.set(0.4, 0.055, 0.4);
    ringB.position.copy(ringA.position);
    ringB.scale.setScalar(1.42);
    ringA.rotation.x = Math.PI / 2;
    ringB.rotation.x = Math.PI / 2;
    hologramGroup.add(ringA, ringB);

    const target = new THREE.Vector3(0.2, 1.25, -0.2);
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      const name = fileNameFromUrl(url);
      if (TEXTURE_FILE_PATTERN.test(name)) {
        return `${ASSET_ROOT}/Textures/${name}`;
      }
      return url;
    });
    const loader = new GLTFLoader(manager);
    const mixers: THREE.AnimationMixer[] = [];

    async function buildScene() {
      const [floor, wall, column, computer, accessPoint, floorLight, cable, alien] = await Promise.all([
        loadPrepared(loader, assetPath("Platforms", "Platform_DarkPlates")),
        loadPrepared(loader, assetPath("Walls", "WallAstra_Straight_Window")),
        loadPrepared(loader, assetPath("Columns", "Column_Astra")),
        loadPrepared(loader, assetPath("Props", "Prop_Computer")),
        loadPrepared(loader, assetPath("Props", "Prop_AccessPoint")),
        loadPrepared(loader, assetPath("Props", "Prop_Light_Floor")),
        loadPrepared(loader, assetPath("Props", "Prop_Cable_1")),
        loadPrepared(loader, assetPath("Aliens", "Alien_Cyclop"))
      ]);

      if (disposed) {
        return;
      }

      for (const x of [-4, 0, 4]) {
        for (const z of [-4, 0, 4]) {
          const tile = clonePrepared(floor.scene);
          tile.position.set(x, 0, z);
          stageGroup.add(tile);
        }
      }

      for (const x of [-4, 0, 4]) {
        const wallPanel = clonePrepared(wall.scene);
        wallPanel.rotation.y = Math.PI / 2;
        wallPanel.position.set(x, 0, -4.6);
        stageGroup.add(wallPanel);
      }

      for (const z of [-2.4, 1.4]) {
        const leftWall = clonePrepared(wall.scene);
        leftWall.position.set(-5.9, 0, z);
        leftWall.rotation.y = Math.PI;
        const rightWall = clonePrepared(wall.scene);
        rightWall.position.set(5.9, 0, z);
        stageGroup.add(leftWall, rightWall);
      }

      for (const x of [-4.7, 4.7]) {
        const pillar = clonePrepared(column.scene);
        normalizeVisibleHeight(pillar, 3.4);
        pillar.position.set(x, 0, -3.6);
        stageGroup.add(pillar);
      }

      const terminal = clonePrepared(computer.scene);
      normalizeVisibleHeight(terminal, 1.35);
      terminal.position.set(3.25, 0, 1.35);
      terminal.rotation.y = -0.78;
      stageGroup.add(terminal);

      const consoleNode = clonePrepared(accessPoint.scene);
      normalizeVisibleHeight(consoleNode, 1);
      consoleNode.position.set(-3.55, 0, -1.5);
      consoleNode.rotation.y = Math.PI * 0.56;
      stageGroup.add(consoleNode);

      const floorLamp = clonePrepared(floorLight.scene);
      floorLamp.position.set(0.2, 0.02, -2.25);
      floorLamp.scale.setScalar(1.15);
      stageGroup.add(floorLamp);

      for (const x of [-2.2, 2.1]) {
        const cableRun = clonePrepared(cable.scene);
        cableRun.position.set(x, 0.035, 2.5);
        cableRun.rotation.y = x < 0 ? 0.55 : -0.35;
        stageGroup.add(cableRun);
      }

      normalizeVisibleHeight(alien.scene, 1.85);
      alien.scene.position.set(-3.25, 0, 0.7);
      alien.scene.rotation.y = 0.92;
      setObjectOpacity(alien.scene, toneConfig[toneRef.current].alienOpacity);
      alienGroup.add(alien.scene);
      playFirstAnimation(alien, mixers);
      rootElement.dataset.stageReady = "true";
    }

    buildScene().catch(() => {
      if (!disposed) {
        rootElement.dataset.stageReady = "false";
      }
    });

    const resize = () => {
      const width = rootElement.clientWidth;
      const height = rootElement.clientHeight;
      if (width <= 0 || height <= 0) {
        return;
      }
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(rootElement);
    resize();

    const timer = new THREE.Timer();
    timer.connect(document);
    renderer.setAnimationLoop((timestamp) => {
      timer.update(timestamp);
      const dt = Math.min(timer.getDelta(), 0.05);
      const elapsed = timer.getElapsed();
      const config = toneConfig[toneRef.current];

      scene.fog?.color.set(config.fill);
      ambientLight.color.set(config.secondary);
      hemiLight.color.set(config.secondary);
      keyLight.color.set(config.accent);
      accentLight.color.set(config.accent);
      hologramMaterial.color.set(config.accent);
      setObjectOpacity(alienGroup, config.alienOpacity);

      if (!reducedMotion) {
        stageGroup.rotation.y = Math.sin(elapsed * 0.12) * 0.025;
        ringA.rotation.z += dt * 0.18;
        ringB.rotation.z -= dt * 0.11;
        alienGroup.rotation.y = Math.sin(elapsed * 0.6) * 0.08;
      }

      for (const mixer of mixers) {
        mixer.update(dt);
      }

      camera.position.x += (config.cameraX + Math.sin(elapsed * 0.1) * 0.16 - camera.position.x) * 0.025;
      camera.position.y += (config.cameraY - camera.position.y) * 0.025;
      camera.position.z += (config.cameraZ - camera.position.z) * 0.025;
      camera.lookAt(target);
      renderer.render(scene, camera);
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      renderer.setAnimationLoop(null);
      timer.dispose();
      if (renderer.domElement.parentNode === rootElement) {
        rootElement.removeChild(renderer.domElement);
      }
      disposeObject(scene);
      ringGeometry.dispose();
      hologramMaterial.dispose();
      renderer.dispose();
    };
  }, []);

  return <div className="chapel-backdrop scifi-stage-backdrop" data-stage-tone={tone} ref={containerRef} aria-hidden="true" />;
}
