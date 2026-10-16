import { AdditiveBlending, Color, ShaderMaterial } from 'three';

/**
 * Fresnel + scanline hologram. Works on SkinnedMesh (three injects skinning
 * uniforms for any material on a skinned mesh; we just include the chunks).
 */
export function createHologramMaterial(color = new Color(0.3, 1.0, 1.5)) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uColor: { value: color },
      uOpacity: { value: 1 },
      uTime: { value: 0 },
      uScan: { value: 1 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <skinning_pars_vertex>
      varying vec3 vN;
      varying vec3 vView;
      varying vec3 vWorld;
      void main() {
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <defaultnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        vN = normalize(transformedNormal);
        vView = normalize(-mvPosition.xyz);
        vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uTime;
      uniform float uScan;
      varying vec3 vN;
      varying vec3 vView;
      varying vec3 vWorld;
      void main() {
        float f = 1.0 - abs(dot(normalize(vN), normalize(vView)));
        float fres = pow(f, 2.2);
        float scan = mix(1.0, 0.7 + 0.3 * sin(vWorld.y * 38.0 - uTime * 7.0), uScan);
        float band = smoothstep(0.96, 1.0, sin(vWorld.y * 3.0 - uTime * 2.5)) * 0.6 * uScan;
        float a = (0.06 + fres * 0.8 + band) * scan * uOpacity;
        gl_FragColor = vec4(uColor * (0.45 + fres * 1.2 + band), a);
      }`,
  });
}
