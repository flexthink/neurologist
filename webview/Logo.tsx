import React from 'react';
import logo from '../assets/neurologist.svg';
export function Logo({className='logo'}:{className?:string}) {
  return <img className={className} src={logo} alt="Neurologist: a neon neural network under a magnifying glass" width="44" height="44"/>;
}
