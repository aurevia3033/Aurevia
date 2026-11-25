import type {ReactNode} from 'react';

export function ErrorState({title='Something went wrong',description,errorAction}:{title?:string;description?:string;errorAction?:ReactNode}){
	return <div className="aurevia-error-state" role="alert">
		<h3>{title}</h3>
		{description&&<p>{description}</p>}
		{errorAction&&<div className="aurevia-error-state-action">{errorAction}</div>}
	</div>;
}
