// Static asset module declarations so `import logo from './logo.png'` typechecks.
// Metro resolves these to a numeric asset id at bundle time.
declare module '*.png' {
  const value: number;
  export default value;
}
declare module '*.jpg' {
  const value: number;
  export default value;
}
declare module '*.jpeg' {
  const value: number;
  export default value;
}
declare module '*.gif' {
  const value: number;
  export default value;
}
declare module '*.webp' {
  const value: number;
  export default value;
}
declare module '*.svg' {
  const value: number;
  export default value;
}
