/** Preserve a recognisable basename and extension in a narrow rail or title. */
export function WorkbenchFilename({ name }: { name: string }) {
  const parts = name.length > 22 && /^(.+?)([^./]{1,5}(?:\.ome)?\.[a-z0-9]{1,8})$/i.exec(name);
  return <span className="workbench-filename" title={name}>{parts
    ? <><span className="workbench-filename-stem">{parts[1]}</span><span className="workbench-filename-suffix">{parts[2]}</span></>
    : name}</span>;
}
