using System.Web.Http;

namespace Legacy.Api.Controllers
{
    // No attribute routes: reached through the conventional "api/{controller}/{id}" template.
    public class ValuesController : ApiController
    {
        public string[] Get() { return new[] { "a", "b" }; }
        public string Get(int id) { return "a"; }
        public void Post([FromBody] string value) { }
    }
}
