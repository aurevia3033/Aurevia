import {NextResponse} from 'next/server';

export async function POST(){
	return NextResponse.json({error:'Akedly phone verification is no longer active.'},{status:410});
}
