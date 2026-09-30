// Buffers that keep their GPU memory between data refreshes. The world is
// re-sent every 20 seconds and orbits are recomputed every 30; reallocating
// every layer each time would leave old buffers for the garbage collector.
// These grow (by powers of two) only when the data outgrows them, and the old
// ones are released right away when they do.

import { BufferAttribute, BufferGeometry, DynamicDrawUsage } from 'three';

const capacityFor = (n: number) => {
  let c = 16;
  while (c < n) c *= 2;
  return c;
};

/**
 * Makes sure `holder.geometry` can draw `n` items with these float attributes
 * (`perItem` vertices each), reusing its buffers when they're big enough.
 */
export function fitGeometry<K extends string>(
  holder: { geometry: BufferGeometry },
  n: number,
  layout: Record<K, number>,
  perItem = 1,
): Record<K, BufferAttribute> {
  const names = Object.keys(layout) as K[];
  const need = Math.max(1, n) * perItem;
  const current = holder.geometry.getAttribute(names[0]) as BufferAttribute | undefined;
  if (!current || current.count < need) {
    const cap = capacityFor(need);
    const fresh = new BufferGeometry();
    for (const name of names) fresh.setAttribute(name, new BufferAttribute(new Float32Array(cap * layout[name]), layout[name]).setUsage(DynamicDrawUsage));
    const old = holder.geometry;
    holder.geometry = fresh;
    old.dispose();
  }
  const g = holder.geometry;
  g.setDrawRange(0, n * perItem);
  const out = {} as Record<K, BufferAttribute>;
  for (const name of names) out[name] = g.getAttribute(name) as BufferAttribute;
  return out;
}

/** Upload only the part of a dynamic buffer that's in use this frame. */
export function markUsed(attr: BufferAttribute, items: number) {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, Math.max(1, items) * attr.itemSize);
  attr.needsUpdate = true;
}

/** Drops the CPU copy of a static buffer once the GPU has it. */
export function releaseAfterUpload(geometry: BufferGeometry) {
  // three reads positions again for bounds (culling, picking), so settle those first
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  for (const name of Object.keys(geometry.attributes)) {
    const a = geometry.attributes[name] as BufferAttribute;
    a.onUpload(function (this: BufferAttribute) {
      // three keeps the array for re-uploads; static buffers never re-upload
      (this as unknown as { array: ArrayLike<number> | null }).array = null;
    });
  }
  if (geometry.index) geometry.index.onUpload(function (this: BufferAttribute) { (this as unknown as { array: ArrayLike<number> | null }).array = null; });
}
