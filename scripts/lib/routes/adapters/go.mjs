import { legacy } from './_legacy.mjs';
const L = ['go'];
export default legacy([
  ['gin', 'Gin', 'go', L, 'partial', /"github\.com\/gin-gonic\/gin"/, ['r.GET("/literal", h)']],
  ['echo', 'Echo', 'go', L, 'partial', /"github\.com\/labstack\/echo(\/v\d+)?"/, ['e.GET("/literal", h)']],
  ['fiber', 'Fiber', 'go', L, 'partial', /"github\.com\/gofiber\/fiber(\/v\d+)?"/, ['app.Get("/literal", h)']],
  ['chi', 'Chi', 'go', L, 'partial', /"github\.com\/go-chi\/chi(\/v\d+)?"/, ['r.Get("/literal", h)']],
  ['gorilla', 'gorilla/mux', 'go', L, 'partial', /"github\.com\/gorilla\/mux"/, ['r.HandleFunc("/literal", h) (method ANY)']],
  ['net-http', 'net/http', 'go', L, 'partial', /"net\/http"/, ['http.HandleFunc("/literal", h) (method ANY; Go 1.22 "GET /x" patterns are not split)']],
]);
