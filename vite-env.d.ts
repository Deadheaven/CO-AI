/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

// lucide-react 1.x ships only a legacy top-level "typings" field that
// bundler moduleResolution ignores (TS7016). Surface it as a proper module.
declare module "lucide-react";

declare module '*.svg?react' {
  import * as React from 'react';
  export const ReactComponent: React.FunctionComponent<React.SVGProps<SVGSVGElement>>;
  const src: string;
  export default src;
}

declare module '*.svg?import&react' {
  import * as React from 'react';
  export const ReactComponent: React.FunctionComponent<React.SVGProps<SVGSVGElement>>;
  const src: string;
  export default src;
}
