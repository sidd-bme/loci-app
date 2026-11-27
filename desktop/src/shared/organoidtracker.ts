export type OrganoidNode = [upstreamTime: number, x: number, y: number, z: number];
export type OrganoidEdge = [from: number, to: number, link: number | null, marginal: number | null];
export interface OrganoidGraph {
  id: string;
  graph_sha256: string;
  source_id: string;
  source_sha256: string;
  file_sha256: string;
  first: number;
  origin: string;
  spacing_xyz_um: number[];
  interval_s: number;
  nodes: OrganoidNode[];
  edges: OrganoidEdge[];
}
