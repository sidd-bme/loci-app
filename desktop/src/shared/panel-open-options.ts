/** Rounded global device-independent coordinates from a panel's pointer release. */
export type PanelDropPoint = Readonly<{ x: number; y: number }>;

export type PanelOpenOptions =
  | { atPointer?: undefined; dropPoint?: never }
  | { atPointer: true; dropPoint?: PanelDropPoint };
