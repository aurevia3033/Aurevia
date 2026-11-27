/** @type {import('next').NextConfig} */
const supabaseUrl=process.env.NEXT_PUBLIC_SUPABASE_URL;
const development=process.env.NODE_ENV!=='production';
const remotePatterns=[];
if(supabaseUrl){
	const storageUrl=new URL(supabaseUrl);
	remotePatterns.push({protocol:storageUrl.protocol.slice(0,-1),hostname:storageUrl.hostname,port:storageUrl.port,pathname:'/storage/v1/object/sign/client-stories/**'});
}
const nextConfig={
	reactStrictMode:true,
	turbopack:{root:process.cwd()},
	distDir:process.env.AUREVIA_NEXT_DIST_DIR||'.next',
	experimental:{agentUpgrade:'security'},
	...(remotePatterns.length?{images:{remotePatterns}}:{}),
	async headers(){
		return [{
			source:'/:path*',
			headers:[
				{key:'Content-Security-Policy',value:`default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'${development?" 'unsafe-eval'":''} https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https: wss:${development?' ws://127.0.0.1:* ws://localhost:*':''}; media-src 'self' data: blob: https:; worker-src 'self' blob:; manifest-src 'self'; form-action 'self' https:; frame-src 'self' https://auth.akedly.io https://www.youtube-nocookie.com https://player.vimeo.com; frame-ancestors 'none'`},
				{key:'Permissions-Policy',value:'camera=(self), microphone=(), geolocation=()'},
				{key:'Referrer-Policy',value:'no-referrer'},
				{key:'Strict-Transport-Security',value:'max-age=31536000'},
				{key:'X-Content-Type-Options',value:'nosniff'},
				{key:'X-Frame-Options',value:'DENY'},
			],
		},{
			source:'/manifest.webmanifest',
			headers:[{key:'Content-Type',value:'application/manifest+json'},{key:'Cache-Control',value:'public, max-age=0, must-revalidate'}],
		},{
			source:'/sw.js',
			headers:[{key:'Cache-Control',value:'no-cache, no-store, must-revalidate'}],
		},{
			source:'/icons/:path*',
			headers:[{key:'Cache-Control',value:'public, max-age=31536000, immutable'}],
		}];
	},
};
export default nextConfig;
