import { legacy } from './_legacy.mjs';
const L = ['rb'];
export default legacy([
  ['rails', 'Ruby on Rails routes', 'ruby', L, 'partial', /Rails\.application\.routes\.draw/, ['resources :name / resource :name (one RESOURCE entry)']],
  ['sinatra', 'Sinatra', 'ruby', L, 'detected', /require\s+['"]sinatra(\/base)?['"]/],
]);
