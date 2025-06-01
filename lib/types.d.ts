declare module 'csstree-validator' {
  export function validate(css: string, filename?: string): Array<{ 
    message: string; 
    line: number; 
    column: number; 
  }>;
} 