// wrangler Data rule (wrangler.toml `rules`): a .bin import is the file's bytes.
declare module "*.bin" {
	const data: ArrayBuffer;
	export default data;
}
