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
      /** base (non-rim) opacity; raise it to make the hologram read as more solid */
      uFill: { value: 0.06 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <skinning_pars_vertex>
      varying vec3 vN;
      varying vec3 vView;
      varying vec3 vWorld;
      varying float vDepth;
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
        vDepth = -mvPosition.z;
        vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uTime;
      uniform float uScan;
      uniform float uFill;
      varying vec3 vN;
      varying vec3 vView;
      varying vec3 vWorld;
      varying float vDepth;
      void main() {
        float f = 1.0 - abs(dot(normalize(vN), normalize(vView)));
        float fres = pow(f, 2.2);
        float scan = mix(1.0, 0.7 + 0.3 * sin(vWorld.y * 38.0 - uTime * 7.0), uScan);
        float band = smoothstep(0.96, 1.0, sin(vWorld.y * 3.0 - uTime * 2.5)) * 0.6 * uScan;
        // fade out when the camera gets inside / very close (avoids a full-screen bloom flash)
        float near = smoothstep(0.35, 1.4, vDepth);
        float a = (uFill + fres * 0.8 + band) * scan * uOpacity * near;
        gl_FragColor = vec4(uColor * (0.45 + fres * 1.2 + band + max(uFill - 0.06, 0.0) * 0.8), a);
      }`,
  });
}
