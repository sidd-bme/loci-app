import lociMark from "../../assets/loci-mark-128.png";

export default function BrandMark(): React.JSX.Element {
  return (
    <img
      className="brand-mark"
      src={lociMark}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
