import { useFrame, useThree } from '@react-three/fiber'
import { useMemo } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import { getResolvedSettings } from './automatedSettings'
import { useStageBackground } from './stageBackground'

const vertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const fragmentShader = /* glsl */ `
uniform sampler2D uImage;
uniform vec3 uBackgroundColor;
uniform float uImageAspect;
uniform float uViewportAspect;
uniform float uOpacity;
uniform float uBrightness;
uniform int uFitMode;

varying vec2 vUv;

void main() {
  vec2 uv = vUv;

  if (uFitMode == 0) {
    vec2 scale = vec2(1.0);
    if (uViewportAspect > uImageAspect) {
      scale.y = uImageAspect / uViewportAspect;
    } else {
      scale.x = uViewportAspect / uImageAspect;
    }
    uv = (vUv - 0.5) * scale + 0.5;
  } else if (uFitMode == 1) {
    if (uViewportAspect > uImageAspect) {
      uv.x = (vUv.x - 0.5) * (uViewportAspect / uImageAspect) + 0.5;
    } else {
      uv.y = (vUv.y - 0.5) * (uImageAspect / uViewportAspect) + 0.5;
    }
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
  }

  vec4 texel = texture2D(uImage, uv);
  float imageAlpha = clamp(texel.a * uOpacity, 0.0, 1.0);
  vec3 imageRgb = texel.rgb * uBrightness;
  gl_FragColor = vec4(mix(uBackgroundColor, imageRgb, imageAlpha), 1.0);

  #include <colorspace_fragment>
}
`

/**
 * Screen-space image backdrop. The plane is drawn before all scene
 * content and has no depth interaction, so camera orbit/zoom cannot
 * reveal its edges. Aspect-aware UVs implement cover/contain/stretch in
 * the same pass that the offline exporter advances.
 */
export function StageBackground() {
  const texture = useStageBackground((state) => state.texture)
  const imageAspect = useStageBackground((state) => state.imageAspect)
  const backgroundMode = useStore((state) => state.settings.backgroundMode)
  const fit = useStore((state) => state.settings.backgroundImageFit)
  const opacity = useStore((state) => state.settings.backgroundImageOpacity)
  const brightness = useStore((state) => state.settings.backgroundImageBrightness)
  const gl = useThree((state) => state.gl)

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uImage: { value: null },
          uBackgroundColor: { value: new THREE.Color('#000000') },
          uImageAspect: { value: 1 },
          uViewportAspect: { value: 1 },
          uOpacity: { value: 1 },
          uBrightness: { value: 1 },
          uFitMode: { value: 0 },
        },
        vertexShader,
        fragmentShader,
        depthTest: false,
        depthWrite: false,
        // Keep this non-tone-mapped so opacity 0 matches the renderer's
        // clear-color background exactly. The composer path also disables
        // tone mapping before rendering the scene.
        toneMapped: false,
      }),
    [],
  )
  const size = useMemo(() => new THREE.Vector2(), [])
  const background = useMemo(() => new THREE.Color(), [])

  material.uniforms.uImage.value = texture
  material.uniforms.uImageAspect.value = imageAspect
  material.uniforms.uOpacity.value = opacity
  material.uniforms.uBrightness.value = brightness
  material.uniforms.uFitMode.value = fit === 'cover' ? 0 : fit === 'contain' ? 1 : 2

  useFrame(() => {
    gl.getDrawingBufferSize(size)
    material.uniforms.uViewportAspect.value = size.x / Math.max(size.y, 1)
    background.set(getResolvedSettings().backgroundColor)
    material.uniforms.uBackgroundColor.value.copy(background)
  })

  if (!texture || backgroundMode !== 'image') return null

  return (
    <mesh renderOrder={-1000} frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <primitive object={material} attach="material" />
    </mesh>
  )
}
