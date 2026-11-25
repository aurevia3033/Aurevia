import AureviaLoading from '@/components/AureviaLoading';

export function LoadingState({label='Loading',detail}:{label?:string;detail?:string}){
	return <AureviaLoading variant="inline" label={label} detail={detail}/>;
}
