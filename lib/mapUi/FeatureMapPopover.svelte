<!--
  FeatureMapPopover — absolute-positioned popover that floats over the
  Mapbox container near a selected feature. Owns positioning + the
  popover surface; defers ALL content to FeatureDetail.

  Replaces the old harness/.../mapFeaturePopover.svelte. Same callsite
  contract (feature + bbox + container size + callbacks) so the only
  change in MapDrawControls is the import path.
-->
<script lang="ts">
import type { Feature } from "geojson";
// FeatureDetail is host-owned (it edits the host's store) — it now arrives as
// ports.ui.FeatureDetail through mapHostPorts (28 Aug 2026).
import MapPopoverShell from "../panels/MapPopoverShell.svelte";
// Now comes from the host through mapHostPorts (28 Aug 2026).
import type { MapHostPorts, MapShareFormat } from "../shared/mapHostPorts";

let {
    ports,
    feature,
    bbox,
    containerWidth,
    containerHeight,
    onShare,
    onSave,
    onClose,
    onChangeIcon,
    onFillOpacity,
    onDelete,
    onContacts,
    onBlock,
}: {
    ports: MapHostPorts;
    feature: Feature;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    containerWidth: number;
    containerHeight: number;
    onShare: (format: MapShareFormat) => void;
    onSave: (name: string, featureDesc: string, featureData: string) => void;
    onClose: () => void;
    onChangeIcon?: (key: string) => void;
    onFillOpacity?: (v: number) => void;
    onDelete?: () => void;
    onContacts?: (keys: string[]) => void;
    onBlock?: (block: string) => void;
} = $props();

const isPoint = $derived(feature.geometry?.type === "Point");
</script>

<MapPopoverShell {bbox} {containerWidth} {containerHeight} {isPoint}>
    <!-- Pins / lines / polygons get an easy delete (the garbage can beside Share).
         The host confirms + removes from mapStore. (Quality-704 PLOT pins use their
         own popover and intentionally have NO trash — a plot pin is its key.) -->
    <ports.ui.FeatureDetail
        {feature}
        {onShare}
        {onSave}
        {onClose}
        {onChangeIcon}
        {onFillOpacity}
        {onDelete}
        {onContacts}
        {onBlock}
    />
</MapPopoverShell>
