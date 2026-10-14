import type { CancellationTone } from "./cancellationPolicy.js";
export declare const iconCheck: (size?: number, color?: string) => string;
export declare const iconCross: (size?: number, color?: string) => string;
export declare const iconWarning: (size?: number, color?: string) => string;
export declare const iconInfo: (size?: number, color?: string) => string;
export declare const iconPin: (size?: number, color?: string) => string;
export declare const iconArrowRight: (size?: number, color?: string) => string;
export declare const iconPrinter: (size?: number, color?: string) => string;
/** Filled aircraft silhouette, nose to the right. */
export declare const iconPlane: (size?: number, color?: string) => string;
/** Decorative passport outline for the partner-offer panel. */
export declare const iconPassport: (size?: number, color?: string) => string;
/** Icon for a cancellation chip tone (the SVG twin of TONE_PALETTE.iconChar). */
export declare function chipIcon(tone: CancellationTone, size?: number): string;
